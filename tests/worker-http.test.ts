import type {IntegrationCompletionEvidence,IntegrationItem} from '../server/integration-queue.ts';
import {defaultCompletionPolicy} from '../server/project-progress.ts';
import {completionPolicyDigest,evaluateTaskCompletion} from '../server/task-completion.ts';
import type {CompletionBinding,CompletionEvidence,TaskCompletion} from '../shared/task-completion.ts';
import type {Run} from '../shared/types.ts';
import {generalCheckerDigest} from '../server/quality-progress.ts';
import type {QualityDimension} from '../shared/quality-progress.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {claudeFixture,FakeClaudeRun,planningInput,tick,outcome} from './claude-task-fixture.ts';
import {CapabilityExecutionService} from '../server/capability-execution.ts';
import {CapabilityRoutingService} from '../server/capability-routing.ts';
import {discoverCapabilities} from '../server/capability-adapters.ts';
import {TaskGraphService} from '../server/task-graph.ts';
import {createHttpServer} from '../server/http.ts';
import type {SavedTask} from '../shared/parallel.ts';

function setup(){
 const runners:FakeClaudeRun[]=[];
 const f=claudeFixture({runnerFactory:config=>{config.beforeDispatch();const r=new FakeClaudeRun();runners.push(r);return r;}});
 const input=JSON.parse(planningInput.text);input.requirements=[1,2,3].map(i=>({id:'R'+i,description:'Report '+i,acceptance_criteria:['Cite evidence']}));
 const {version}=f.plan({...planningInput,text:JSON.stringify(input)}),tasks=f.studio.read(f.project.id,'tasks') as SavedTask[];
 new TaskGraphService(f.store).save(f.project.id,{planningVersionId:version.id,contentHash:version.contentHash,expectedRevision:0,nodes:tasks.map(t=>({taskId:t.id})),edges:[{taskId:tasks[2].id,dependsOn:tasks[0].id}]});
 const registry=discoverCapabilities({codexReady:true,probe:{checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.165.0'},claude:{status:'found',version:'2.1.312'}}});
 const execution=new CapabilityExecutionService(f.store,f.controller,()=>registry),routing=new CapabilityRoutingService(f.store);
 const plans=tasks.map(t=>execution.plan(f.project.id,{requestId:randomUUID(),routeId:routing.recommend(f.project.id,{requestId:randomUUID(),taskId:t.id,text:'문서 작성'},registry).id}));
 const inputBatch={requestId:randomUUID(),planningVersionId:version.id,graphRevision:1,planningHash:version.contentHash,confirmed:true,executions:plans.map(p=>({executionId:p.id,expectedPlanDigest:p.planDigest}))};
 return {...f,runners,execution,inputBatch,plans,async close(){await f.controller.stopWorkers();for(const r of runners)r.finish(outcome('interrupted'));await tick();const writable=(p:string)=>{chmodSync(p,0o700);for(const e of readdirSync(p,{withFileTypes:true}))if(e.isDirectory())writable(join(p,e.name));};writable(f.dir);await f.close();}};
}

test('worker batches bind approved plans, submit roots once, expose limits and keep GET projections inert',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution);
  const batch=f.controller.createWorkerBatch(f.project.id,f.inputBatch);
  const request={requestId:randomUUID()};
  await f.controller.submitWorkerBatch(f.project.id,batch.id,request);
  await f.controller.submitWorkerBatch(f.project.id,batch.id,request);
  assert.equal(f.runners.length,2);
  const seq=f.store.lastSeq(),view=f.controller.workerBatch(f.project.id,batch.id);
  assert.deepEqual(view.limits,{total:2,perRuntime:{codex:1,'claude-code':2}});
  assert.equal(view.reservations.length,2);assert.equal(view.spaces.length,2);
  assert.ok(view.reasons.some(r=>r.code==='WORKER_DEPENDENCIES_WAITING'));
  assert.equal(view.integration.reason,'INTEGRATION_DISABLED');
  f.controller.workerIntegrationQueue(f.project.id);assert.equal(f.store.lastSeq(),seq);assert.equal(f.runners.length,2);
  f.runners[0].finish();await tick();await tick();
  assert.equal(f.controller.workerBatch(f.project.id,batch.id).reservations[0].state,'terminal_confirmed');
  assert.equal(f.controller.workerIntegrationQueue(f.project.id).items.length,1);
  assert.equal(f.controller.workerIntegrationQueue(f.project.id).items[0].status,'queued');
 }finally{await f.close();}
});

test('worker batches reject request fields, stale graph and missing confirmation',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution);
  for(const extra of [{verifiedDoneIds:['forged']},{completion:{verifiedDone:true}},{targetBranch:'dev'},{baseSha:'a'.repeat(40)},{paths:['output']},{defaultBranch:'main'}])assert.throws(()=>f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,...extra}),/INVALID_FIELDS/);
  assert.throws(()=>f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,confirmed:false}),/APPROVAL/);
  assert.throws(()=>f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,graphRevision:2}),/BASELINE/);
  assert.equal(f.runners.length,0);
 }finally{await f.close();}
});

test('HTTP workers enforce session, Origin, CSRF and exact fields; GET never dispatches or appends',async()=>{
 // Bind the fake runtime registry first; otherwise the host's live probe cache decides runtime versions.
 const f=setup();f.controller.initializeWorkers(f.execution);const server=createHttpServer(f.controller,'.');
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,base=`/api/projects/${f.project.id}/worker-batches`;
  assert.equal((await fetch(origin+base+'/'+randomUUID())).status,401);
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const post=(path:string,data:object,extra:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  assert.equal((await post(base,f.inputBatch,{'X-CSRF-Token':''})).status,403);
  assert.equal((await post(base,f.inputBatch,{Origin:'http://example.invalid'})).status,403);
  assert.equal((await post(base,{...f.inputBatch,path:'/tmp'})).status,400);
  const made=await post(base,f.inputBatch);assert.equal(made.status,200);const batch=await made.json() as {id:string};
  const seq=f.store.lastSeq();
  for(const path of [base+'/'+batch.id,`/api/projects/${f.project.id}/integration-queue`])assert.equal((await fetch(origin+path,{headers})).status,200);
  assert.equal(f.store.lastSeq(),seq);assert.equal(f.runners.length,0);
  const request={requestId:randomUUID()};assert.equal((await post(base+'/'+batch.id+'/submit',request)).status,200);
  assert.equal((await post(base+'/'+batch.id+'/submit',request)).status,200);assert.equal(f.runners.length,2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('protected main, master and trusted default are refused before dispatch',async()=>{
 for(const targetBranch of ['main','master','trunk']){
  const f=setup();try{
   f.controller.initializeWorkers(f.execution,{targetBranch,projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]});
   assert.equal(f.controller.workerIntegrationQueue(f.project.id).reason,'INTEGRATION_TARGET_PROTECTED');
   assert.throws(()=>f.controller.createWorkerBatch(f.project.id,f.inputBatch),/INTEGRATION_TARGET_PROTECTED/);
   assert.equal(f.runners.length,0);
  }finally{await f.close();}
 }
});

// Candidate-specific native observations are fixtures. A bare command verdict is
// intentionally insufficient; the successful path also supplies every CQG gate.
// The same evidence shape is bound either to the candidate or to the source attempt's artifact.
const fixturePolicy={...defaultCompletionPolicy('general'),dependencyRelease:'quality_passed' as const};
function fixtureBinding(f:ReturnType<typeof setup>,item:Readonly<IntegrationItem>):CompletionBinding {
 const r=JSON.parse(String(f.store.db.prepare('SELECT body FROM worker_reservations WHERE id=?').get(item.fence.reservationId)!.body)) as import('../shared/parallel-workers.ts').WorkerReservation;
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 return {projectId:item.projectId,taskId:r.attempt.taskId,runId:f.store.findRequest(r.attempt.dispatchRequestId)!.run.id,planningVersionId:r.batch.planningVersionId,planningContentHash:item.approvedBaseline,acceptanceDigest:f.store.findRequest(r.attempt.dispatchRequestId)!.run.acceptanceDigest??null,artifactId:item.id,artifactDigest:item.candidateDigest,graphRevision:String(r.batch.graphRevision),contractDigest:hash(r.batch.contractDigests),policyDigest:completionPolicyDigest(fixturePolicy),configDigest:item.configDigest,artifactScope:'task_manifest' as const,baseSha:null,inputSnapshotDigest:item.space.inputDigest};
}
function fixtureEvidence(binding:CompletionBinding):CompletionEvidence {
 const model=(id:string)=>({providerId:'fixture',modelId:id,runId:id==='producer'?binding.runId:'candidate-'+id,sessionId:'session-'+id,source:'native_observed' as const,evidenceSource:'native' as const});
 const d=(status:QualityDimension['status']='not_run',evidenceIds:string[]=[]):QualityDimension=>({status,evidenceIds,blockers:[],nextAction:null});
 const id=binding.artifactId+'review',artifact={id:binding.artifactId!,digest:binding.artifactDigest!};
 const review={modelKey:'fixture/reviewer',sessionId:'session-reviewer',baselineDigest:binding.planningContentHash!,artifactDigest:artifact.digest,criteria:[{criterion:'Cite evidence',status:'met' as const,evidence:'candidate fixture checked'}],findings:[]};
 const evidence:CompletionEvidence={quality:{execution:{...d('completed'),evidenceSource:'native'},format:d(),codeVerification:d(),semantic:d('passed',[id]),independentReview:d('completed',[id]),repair:d(),revalidation:d(),userApproval:d(),evidence:[]},producer:{binding,model:model('producer')},bindings:{},checks:[],commands:[],gateResults:[],approvals:[],loops:[{id,projectId:binding.projectId!,taskId:binding.taskId!,sourceRunId:binding.runId!,baseline:{id:binding.planningVersionId!,digest:binding.planningContentHash!,criteria:['Cite evidence']},producer:model('producer'),reviewers:[{id:'reviewer',providerId:'fixture',modelId:'reviewer'}],recoveryRequired:false,result:{status:'passed',issue:null,calls:1,repairs:0,artifact,rounds:[{number:1,artifact,reviews:[{reviewerId:'reviewer',result:review}],failures:[]}]},steps:[{id:'step',index:1,kind:'review',state:'completed',requestDigest:'request',startedAt:'start',finishedAt:'finish',issue:null,evidence:model('reviewer'),result:review}],verification:{status:'passed',checkIds:[],issue:null}}]};
 for(const [key,kind] of [[id,'quality_loop'],[binding.artifactId+'format','artifact_check'],[binding.artifactId+'numeric','artifact_check']] as const){evidence.bindings[key]={...binding};evidence.quality.evidence.push({id:key,kind,binding:{...binding},evidenceSource:kind==='quality_loop'?'native':'local',freshness:'current',recordedStatus:'passed',blockers:[]});}
 evidence.gateResults=[{gate:'artifact_format',evidenceId:binding.artifactId+'format',status:'passed'},{gate:'numeric_source',evidenceId:binding.artifactId+'numeric',status:'passed'}];
 return evidence;
}
function candidateFixture(f:ReturnType<typeof setup>,item:Readonly<IntegrationItem>):IntegrationCompletionEvidence {
 const binding=fixtureBinding(f,item),evidence:IntegrationCompletionEvidence['evidence']=fixtureEvidence(binding),semantic=item.id+'semantic';
 // CQG-6c: a candidate's semantic_review gate is satisfied only by a local candidate-bound check.
 evidence.bindings[semantic]={...binding};evidence.quality.evidence.push({id:semantic,kind:'artifact_check',binding:{...binding},evidenceSource:'local',freshness:'current',recordedStatus:'passed',blockers:[]});
 evidence.gateResults.push({gate:'semantic_review',evidenceId:semantic,status:'passed'});
 return {subject:{integrationId:item.id,candidateDigest:item.candidateDigest!,targetDigest:item.generalTargetDigest},binding,evidence};
}
// The source attempt's completion is computed by the real CQG-1 evaluator, never hand-set.
function sourceFixture(f:ReturnType<typeof setup>,item:Readonly<IntegrationItem>,done=true):TaskCompletion {
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const binding={...fixtureBinding(f,item),artifactId:item.space.attemptId,artifactDigest:hash(item.manifest)},evidence=fixtureEvidence(binding);
 if(!done)evidence.gateResults=evidence.gateResults.filter(g=>g.gate!=='numeric_source');
 const completion=evaluateTaskCompletion(evidence,fixturePolicy,binding);
 assert.equal(completion.verifiedDone,done,completion.reasonCodes.join(','));
 return completion;
}
for(const verdict of ['passed','failed','blocked'] as const){
 test(`terminal completion automatically queues full candidate verification: ${verdict}`,async()=>{
  const f=setup();try{
   f.controller.initializeWorkers(f.execution,{targetBranch:'dev',projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]},{policy:()=>({...defaultCompletionPolicy('general'),dependencyRelease:'quality_passed'}),candidate:item=>candidateFixture(f,item),source:item=>sourceFixture(f,item)});
   let checks=0;f.controller.verification.verifyIntegration=async input=>{checks++;assert.deepEqual(input.requiredChecks,['full']);input.assertCurrent();return verdict;};
   const batch=f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,executions:f.inputBatch.executions.slice(0,1)});
   await f.controller.submitWorkerBatch(f.project.id,batch.id,{requestId:randomUUID()});
   const space=f.controller.workerBatch(f.project.id,batch.id).spaces[0];
   const {writeFileSync,existsSync}=await import('node:fs');writeFileSync(join(space.path,'output/report.txt'),'verified output');
   f.runners[0].finish();await tick();await tick();await tick();
   const queue=f.controller.workerIntegrationQueue(f.project.id);assert.equal(queue.items.length,1);assert.equal(checks,1);
   assert.equal(queue.items[0].status,verdict==='passed'?'applied':verdict==='failed'?'refused':'blocked');
   assert.equal(f.controller.workerBatch(f.project.id,batch.id).reservations[0].state,verdict==='blocked'?'terminal_confirmed':'released');
   assert.equal(existsSync(join(f.project.path,'output/report.txt')),verdict==='passed');
  }finally{await f.close();}
 });
}

test('passed candidate whose source attempt is not verified done refuses auto-apply',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution,{targetBranch:'dev',projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]},{policy:()=>({...defaultCompletionPolicy('general'),dependencyRelease:'quality_passed'}),candidate:item=>candidateFixture(f,item),source:item=>sourceFixture(f,item,false)});
  let checks=0;f.controller.verification.verifyIntegration=async input=>{checks++;input.assertCurrent();return 'passed';};
  const batch=f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,executions:f.inputBatch.executions.slice(0,1)});
  await f.controller.submitWorkerBatch(f.project.id,batch.id,{requestId:randomUUID()});
  const space=f.controller.workerBatch(f.project.id,batch.id).spaces[0];
  const {writeFileSync,existsSync}=await import('node:fs');writeFileSync(join(space.path,'output/report.txt'),'verified output');
  f.runners[0].finish();await tick();await tick();await tick();
  const item=f.controller.workerIntegrationQueue(f.project.id).items[0];assert.equal(checks,1);
  assert.equal(item.status,'refused');assert.match(item.reason??'',/CQG_SOURCE_NOT_VERIFIED_DONE/);
  assert.doesNotMatch(item.reason??'',/CQG_SOURCE_BINDING_MISMATCH|CQG_CANDIDATE_SUBJECT_MISMATCH/);
  assert.equal(existsSync(join(f.project.path,'output/report.txt')),false);
 }finally{await f.close();}
});

for(const done of [true,false])test(`real Controller source reader delivers the source attempt completion: ${done?'verified done applies':'not done refuses'}`,async()=>{
 const f=setup();try{
  // No injected source reader: the queue reads the source through readIntegrationSource and the
  // ProjectProgress CQG-1 read model. Only the trusted host evidence adapter (CompletionReaders.evidence)
  // supplies fixture observations; their binding is derived independently here, so any mismatch with the
  // read model's own derivation fails CQG-1 instead of being copied through.
  let current:Readonly<IntegrationItem>|undefined;
  f.controller.initializeWorkers(f.execution,{targetBranch:'dev',projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]},{policy:()=>fixturePolicy,candidate:item=>{
   // Fixture gap, not product behaviour: CQG-1 requires a bound acceptance digest, but general Claude
   // worker runs are dispatched without one (and capability-execution rejects a changed digest while
   // running), so it is bound only after terminal detection, when the queue reads candidate evidence.
   current=item;const run=f.store.getRun(fixtureBinding(f,item).runId!)!;
   // GENERAL-ACCEPT-A: general worker runs carry the server-computed acceptance digest; never patch it in.
   assert.match(String(run.acceptanceDigest),/^[a-f0-9]{64}$/);
   return candidateFixture(f,item);
  }});
  let sourceReads=0;
  Reflect.get(f.controller.progress,'qualityReaders').evidence=(base:CompletionEvidence,run:Run)=>{
   if(!current||run.id!==fixtureBinding(f,current).runId)return base;
   const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
   const evidence=fixtureEvidence({...fixtureBinding(f,current),artifactId:current.space.attemptId,artifactDigest:hash(current.manifest),configDigest:generalCheckerDigest()});sourceReads++;
   if(!done)evidence.gateResults=evidence.gateResults.filter(g=>g.gate!=='numeric_source');
   return evidence;
  };
  let checks=0;f.controller.verification.verifyIntegration=async input=>{checks++;input.assertCurrent();return 'passed';};
  const batch=f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,executions:f.inputBatch.executions.slice(0,1)});
  await f.controller.submitWorkerBatch(f.project.id,batch.id,{requestId:randomUUID()});
  const space=f.controller.workerBatch(f.project.id,batch.id).spaces[0];
  const {writeFileSync,existsSync}=await import('node:fs');writeFileSync(join(space.path,'output/report.txt'),'verified output');
  f.runners[0].finish();await tick();await tick();await tick();
  const item=f.controller.workerIntegrationQueue(f.project.id).items[0];assert.equal(checks,1);assert.ok(sourceReads>0);
  assert.equal(item.status,done?'applied':'refused',item.reason??'');
  if(!done){assert.match(item.reason??'',/CQG_SOURCE_NOT_VERIFIED_DONE/);assert.doesNotMatch(item.reason??'',/CQG_SOURCE_BINDING_MISMATCH|CQG_CANDIDATE_SUBJECT_MISMATCH/);}
  assert.equal(existsSync(join(f.project.path,'output/report.txt')),done);
 }finally{await f.close();}
});

test('server restart fences running attempts and replay never dispatches or applies',async()=>{
 const {Store}=await import('../server/store.ts'),{Projects}=await import('../server/projects.ts'),{Controller}=await import('../server/controller.ts');
 const f=setup();let other:InstanceType<typeof Store>|undefined,restarted:InstanceType<typeof Controller>|undefined;
 try{
  f.controller.initializeWorkers(f.execution);const batch=f.controller.createWorkerBatch(f.project.id,f.inputBatch),request={requestId:randomUUID()};
  await f.controller.submitWorkerBatch(f.project.id,batch.id,request);assert.equal(f.runners.length,2);await f.controller.stopWorkers();
  other=new Store(f.db);const projects=new Projects(other,f.managed,[],f.root);
  restarted=new Controller(other,f.dir,()=>{throw Error('NO_NATIVE');},projects,[],[],{findExecutable:()=>'/fake/claude',runnerFactory:()=>{throw Error('NO_REDISPATCH');}});
  const execution=new CapabilityExecutionService(other,restarted,()=>discoverCapabilities({codexReady:false,probe:null}));restarted.initializeWorkers(execution);
  let applies=0;restarted.merges.applyIntegration=()=>{applies++;throw Error('NO_APPLY');};
  await restarted.submitWorkerBatch(f.project.id,batch.id,request);
  const seq=other.lastSeq();const view=restarted.workerBatch(f.project.id,batch.id);restarted.workerIntegrationQueue(f.project.id);
  assert.equal(other.lastSeq(),seq);assert.ok(view.reservations.every(r=>r.state==='lost_unknown'));assert.equal(f.runners.length,2);assert.equal(applies,0);
  restarted.initializeWorkers(execution);assert.equal(other.lastSeq(),seq,'initialization is once per Controller');
 }finally{await restarted?.stopWorkers();await restarted?.close();other?.close();await f.close();}
});

test('configuration is server-only and unset integration target disables automatic application',async()=>{
 const {readWorkerConfiguration}=await import('../server/controller.ts');
 assert.equal(readWorkerConfiguration(undefined,undefined).targetBranch,undefined);
 assert.throws(()=>readWorkerConfiguration('dev','[{"defaultBranch":"main"}]'),/INVALID_WORKER_CONFIGURATION/);
 assert.throws(()=>readWorkerConfiguration('refs/heads/main',undefined),/INVALID_WORKER_CONFIGURATION/);
});

test('approved input hashes reject changed materials before dispatch',async()=>{
 const f=setup();try{
  f.controller.addMaterials(f.project.id,{files:[{name:'evidence.txt',text:'original evidence'}]});
  f.controller.initializeWorkers(f.execution);const batch=f.controller.createWorkerBatch(f.project.id,f.inputBatch);
  assert.equal(batch.batch.inputArtifactHashes.length,1);
  const {writeFileSync}=await import('node:fs');writeFileSync(join(f.project.path,'inputs/evidence.txt'),'changed evidence');
  const view=await f.controller.submitWorkerBatch(f.project.id,batch.id,{requestId:randomUUID()});
  assert.equal(f.runners.length,0);assert.ok(view.reasons.every(r=>r.code==='WORKER_INPUTS_CHANGED'));
 }finally{await f.close();}
});

for(const status of ['queued','verifying','applying','applied'] as const){
 test(`AX03: Controller restart with ${status} queue item never dispatches, verifies or applies again`,async()=>{
  const {Store}=await import('../server/store.ts'),{Projects}=await import('../server/projects.ts'),{Controller}=await import('../server/controller.ts');
  const f=setup();let other:InstanceType<typeof Store>|undefined,restarted:InstanceType<typeof Controller>|undefined;
  try{
   const config={targetBranch:'dev',projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]};
   // Leave a frozen queue item with integration disabled, then simulate the durable crash boundary.
   f.controller.initializeWorkers(f.execution);const batch=f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,executions:f.inputBatch.executions.slice(0,1)}),request={requestId:randomUUID()};
   await f.controller.submitWorkerBatch(f.project.id,batch.id,request);f.runners[0].finish();await tick();await tick();
   const item=f.controller.workerIntegrationQueue(f.project.id).items[0];assert.ok(item);await f.controller.stopWorkers();
   f.store.db.prepare('UPDATE integration_queue SET slot=?,body=? WHERE id=?').run(status==='queued'?null:1,JSON.stringify({...item,status,released:false}),item.id);
   other=new Store(f.db);const projects=new Projects(other,f.managed,[],f.root);
   restarted=new Controller(other,f.dir,()=>{throw Error('NO_NATIVE');},projects);
   let checks=0,applies=0;restarted.verification.verifyIntegration=async()=>{checks++;return 'passed';};restarted.merges.applyIntegration=()=>{applies++;throw Error('NO_APPLY');};
   const execution=new CapabilityExecutionService(other,restarted,()=>discoverCapabilities({codexReady:false,probe:null}));restarted.initializeWorkers(execution,config);
   await restarted.submitWorkerBatch(f.project.id,batch.id,request);await tick();
   const result=restarted.workerIntegrationQueue(f.project.id).items[0];
   assert.equal(result.status,status==='applied'?'applied':'blocked');
   assert.equal(restarted.workerBatch(f.project.id,batch.id).reservations[0].state,status==='applied'?'released':'terminal_confirmed');
   assert.equal(f.runners.length,1);assert.equal(checks,0);assert.equal(applies,0);
   const seq=other.lastSeq();restarted.workerBatch(f.project.id,batch.id);assert.equal(other.lastSeq(),seq);
  }finally{await restarted?.stopWorkers();await restarted?.close();other?.close();await f.close();}
 });
}

test('concurrent submit replay dispatches each root at most once and conflicts across batches',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution);const batch=f.controller.createWorkerBatch(f.project.id,f.inputBatch),request={requestId:randomUUID()};
  const other=f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,requestId:randomUUID()});
  await Promise.all([f.controller.submitWorkerBatch(f.project.id,batch.id,request),f.controller.submitWorkerBatch(f.project.id,batch.id,request)]);
  assert.equal(f.runners.length,2);
  await assert.rejects(f.controller.submitWorkerBatch(f.project.id,other.id,request),/IDEMPOTENCY_CONFLICT/);
  assert.equal(f.controller.createWorkerBatch(f.project.id,f.inputBatch).id,batch.id);
 }finally{await f.close();}
});

test('shutdown waits for in-flight candidate verification before Store can close',async()=>{
 const f=setup();let release!:()=>void;
 try{
  f.controller.initializeWorkers(f.execution,{targetBranch:'dev',projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]});
  let entered!:()=>void;const started=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>release=r);
  f.controller.verification.verifyIntegration=async()=>{entered();await barrier;return 'blocked';};
  const batch=f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,executions:f.inputBatch.executions.slice(0,1)});
  await f.controller.submitWorkerBatch(f.project.id,batch.id,{requestId:randomUUID()});f.runners[0].finish();await started;
  let stopped=false;const stopping=f.controller.stopWorkers().then(()=>{stopped=true;});await tick();assert.equal(stopped,false);
  release();await stopping;assert.equal(stopped,true);assert.equal(f.controller.workerIntegrationQueue(f.project.id).items[0].status,'blocked');
 }finally{release?.();await f.close();}
});

test('temporary Codex activity defers integration without consuming the durable queue slot',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution,{targetBranch:'dev',projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]});
  const batch=f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,executions:f.inputBatch.executions.slice(0,1)});
  await f.controller.submitWorkerBatch(f.project.id,batch.id,{requestId:randomUUID()});
  const codex=f.store.createRun(randomUUID(),'busy','busy');
  let checks=0;const verify=f.controller.verification.verifyIntegration.bind(f.controller.verification);
  f.controller.verification.verifyIntegration=async input=>{checks++;return verify(input);};
  f.runners[0].finish();await tick();await tick();
  assert.equal(checks,0);assert.equal(f.controller.workerIntegrationQueue(f.project.id).items[0].status,'queued');
  assert.equal(f.store.db.prepare('SELECT id FROM integration_queue WHERE slot=1').get(),undefined);
  f.store.updateRun(codex.id,{execution:'completed'},'run.completed');await tick();await tick();
  assert.equal(checks,1,'completion wakes the queue and reaches the real verification service');
  assert.equal(f.controller.workerIntegrationQueue(f.project.id).items[0].reason,'INTEGRATION_REQUIRED_CHECK_BLOCKED');
 }finally{await f.close();}
});

test('enabled integration refuses an unconfigured project before it can stall other projects',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution,{targetBranch:'dev'});
  assert.throws(()=>f.controller.createWorkerBatch(f.project.id,f.inputBatch),/INTEGRATION_PROJECT_CONFIGURATION_REQUIRED/);
  assert.equal(f.controller.workerIntegrationQueue(f.project.id).items.length,0);assert.equal(f.runners.length,0);
 }finally{await f.close();}
});

test('graph revision changed during execution durably refuses integration and releases terminal slots',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution,{targetBranch:'dev',projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]});
  const batch=f.controller.createWorkerBatch(f.project.id,f.inputBatch);
  await f.controller.submitWorkerBatch(f.project.id,batch.id,{requestId:randomUUID()});
  const graphs=new TaskGraphService(f.store),graph=graphs.read(f.project.id,f.inputBatch.planningVersionId);
  graphs.save(f.project.id,{planningVersionId:graph.planningVersionId,contentHash:graph.contentHash,expectedRevision:graph.revision,nodes:graph.nodes,edges:graph.edges});
  for(const r of f.runners)r.finish();await tick();await tick();
  const view=f.controller.workerBatch(f.project.id,batch.id);
  assert.ok(view.reservations.every(r=>r.state==='released'));
  assert.equal(view.integration.refusals.length,2);assert.ok(view.integration.refusals.every(r=>r.reason==='INTEGRATION_BASELINE_CHANGED'));
  const seq=f.store.lastSeq();f.controller.workerIntegrationQueue(f.project.id);assert.equal(f.store.lastSeq(),seq);
 }finally{await f.close();}
});

test('candidate command pass without a candidate evidence reader still refuses auto-apply',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution,{targetBranch:'dev',projects:[{projectPath:f.project.path,defaultBranch:'trunk',requiredChecks:['full']}]},
   {policy:()=>({...defaultCompletionPolicy('general'),dependencyRelease:'quality_passed'}),candidate:()=>null});
  f.controller.verification.verifyIntegration=async()=> 'passed';
  const batch=f.controller.createWorkerBatch(f.project.id,{...f.inputBatch,executions:f.inputBatch.executions.slice(0,1)});
  await f.controller.submitWorkerBatch(f.project.id,batch.id,{requestId:randomUUID()});
  const space=f.controller.workerBatch(f.project.id,batch.id).spaces[0];
  const {writeFileSync}=await import('node:fs');writeFileSync(join(space.path,'output/report.txt'),'unverified');
  f.runners[0].finish();await tick();await tick();await tick();
  const item=f.controller.workerIntegrationQueue(f.project.id).items[0];
  assert.equal(item.status,'refused');assert.equal(item.reason,'INTEGRATION_COMPLETION_EVIDENCE_REQUIRED');
 }finally{await f.close();}
});
