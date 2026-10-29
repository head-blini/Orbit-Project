import {ProjectProgressService} from '../server/project-progress.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {tick,planningInput} from './claude-task-fixture.ts';
import {CapabilityExecutionService} from '../server/capability-execution.ts';
import {CapabilityRoutingService} from '../server/capability-routing.ts';
import {discoverCapabilities} from '../server/capability-adapters.ts';
import {TaskGraphService} from '../server/task-graph.ts';
import {WorkerScheduler,approvedWorkerBase} from '../server/worker-scheduler.ts';
import {resolveWorkerPath} from '../server/worker-spaces.ts';
import type {ApprovedExecutionBatch} from '../shared/parallel-workers.ts';
import type {SavedTask} from '../shared/parallel.ts';

import type {Store} from '../server/store.ts';
import {trustedGit} from '../server/git-process.ts';
import {inspectIntegrationTarget,prepareIntegrationCandidate,applyMergeCandidate,isAncestor} from '../server/merge-git.ts';
import {ParallelWorkerService} from '../server/parallel-workers.ts';
import {WorkerSpaces} from '../server/worker-spaces.ts';

import {VerificationService} from '../server/verification-service.ts';
import {MergeService} from '../server/merge-service.ts';
import {IntegrationQueue,readCandidateCompletion,type IntegrationItem,type IntegrationCompletionEvidence} from '../server/integration-queue.ts';
import {CODE_GATES,GENERAL_GATES,type CompletionPolicy,type CompletionEvidence} from '../shared/task-completion.ts';
import {completionPolicyDigest,evaluateTaskCompletion} from '../server/task-completion.ts';
import {readVerificationConfiguration,verificationCommandPreviews,verificationGateCommandMap} from '../server/verification-configuration.ts';
import type {QualityDimension} from '../shared/quality-progress.ts';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dimension=(status:QualityDimension['status']='not_run',evidenceIds:string[]=[]):QualityDimension=>({status,evidenceIds,blockers:[],nextAction:null});
// Native model/review observations are fixtures, never live provider evidence.
function candidateEvidence(item:IntegrationItem,store:Store,policy:CompletionPolicy,commands:CompletionEvidence['commands'],source=false):IntegrationCompletionEvidence {
 const reservation=new ParallelWorkerService(store).read(item.fence.reservationId);
 const binding={projectId:item.projectId,taskId:reservation.attempt.taskId,runId:'run-producer',planningVersionId:reservation.batch.planningVersionId,
  planningContentHash:item.approvedBaseline,acceptanceDigest:'acceptance',artifactId:item.id,artifactDigest:item.candidateDigest,
  graphRevision:String(reservation.batch.graphRevision),contractDigest:digest(reservation.batch.contractDigests),policyDigest:completionPolicyDigest(policy),configDigest:item.configDigest,
  artifactScope:item.space.kind==='code'?'workspace' as const:'task_manifest' as const,baseSha:item.target?.head??null,inputSnapshotDigest:item.space.inputDigest};
 const model=(id:string)=>({providerId:'provider',modelId:id,sessionId:'session-'+id,runId:'run-'+id,source:'native_observed' as const,evidenceSource:'native' as const});
 const evidence:CompletionEvidence={quality:{execution:{...dimension('completed'),evidenceSource:'native'},format:dimension(),codeVerification:dimension(),semantic:dimension(),independentReview:dimension(),repair:dimension(),revalidation:dimension(),userApproval:dimension(),evidence:[]},
  producer:{binding:{...binding},model:model('producer')},bindings:{},checks:[],commands,loops:[],gateResults:[],approvals:[]};
 const add=(id:string,kind:'verification_check'|'artifact_check'|'quality_loop',source:'local'|'native'='local')=>{
  evidence.bindings[id]={...binding};evidence.quality.evidence.push({id,kind,evidenceSource:source,freshness:'current',recordedStatus:'passed',binding:{...binding},blockers:[]});
 };
 if(item.space.kind==='code'){
  for(const row of store.db.prepare('SELECT id,body FROM integration_checks').all()){
   const check=JSON.parse(String(row.body)),r=check.result;
   if(check.integrationId!==item.id||check.sourceDigest!==item.candidateDigest||r?.baseSha!==item.target?.head)continue;
   const id=String(row.id);add(id,'verification_check');
   evidence.checks.push({id,requestId:id,runId:binding.runId,projectId:item.projectId,workspaceId:item.id,taskId:binding.taskId,planningVersionId:binding.planningVersionId,
    planningContentHash:binding.planningContentHash,acceptanceDigest:binding.acceptanceDigest,commandId:check.commandId,configDigest:commands.find(c=>c.id===check.commandId)!.configDigest,
    baseSha:r.baseSha,sourceDigest:r.sourceDigest,finishedDigest:r.finishedDigest,createdAt:r.startedAt,completedAt:new Date(Date.parse(r.startedAt)+r.durationMs).toISOString(),
    execution:'completed',verdict:r.status,exitCode:r.exitCode,durationMs:r.durationMs,output:r.output,recoveredAt:null,evidenceSource:'local'});
  }
 }else{
  for(const gate of ['artifact_format','numeric_source'] as const){const id=item.id+gate;add(id,'artifact_check');evidence.gateResults.push({gate,evidenceId:id,status:'passed'});}
  const id=item.id+'review';add(id,'quality_loop','native');evidence.quality.semantic=dimension('passed',[id]);evidence.quality.independentReview=dimension('completed',[id]);
  const artifact={id:item.id,digest:item.candidateDigest!},review={modelKey:'provider/reviewer',sessionId:'session-reviewer',baselineDigest:item.approvedBaseline,artifactDigest:item.candidateDigest!,criteria:[{criterion:'correct',status:'met' as const,evidence:'checked candidate'}],findings:[]};
  evidence.loops.push({id,projectId:item.projectId,taskId:binding.taskId,sourceRunId:binding.runId,baseline:{id:binding.planningVersionId,digest:item.approvedBaseline,criteria:['correct']},producer:model('producer'),reviewers:[{id:'reviewer',providerId:'provider',modelId:'reviewer'}],recoveryRequired:false,
   result:{status:'passed',issue:null,calls:1,repairs:0,artifact,rounds:[{number:1,artifact,reviews:[{reviewerId:'reviewer',result:review}],failures:[]}]},
   steps:[{id:'review-step',index:1,kind:'review',state:'completed',requestDigest:'request',startedAt:'start',finishedAt:'finish',issue:null,evidence:model('reviewer'),result:review}],verification:{status:'passed',checkIds:[],issue:null}});
 }
 if(!source){
  evidence.producer=undefined;evidence.quality.execution.evidenceSource='local';
  evidence.loops=[];evidence.quality.semantic=dimension();evidence.quality.independentReview=dimension();
  evidence.quality.evidence=evidence.quality.evidence.filter(e=>e.kind!=='quality_loop');
  if(item.space.kind==='general'){
   const id=item.id+'semantic';add(id,'artifact_check');
   (evidence as IntegrationCompletionEvidence['evidence']).gateResults.push({gate:'semantic_review',evidenceId:id,status:'passed'});
  }
 }
 return {subject:{integrationId:item.id,candidateDigest:item.candidateDigest!,targetDigest:item.target?.head??item.generalTargetDigest},binding,evidence};
}


async function codeFixture(){
 const {EventEmitter}=await import('node:events');
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('./temp.ts');
 const {Store}=await import('../server/store.ts'),{Projects}=await import('../server/projects.ts');
 const {Controller}=await import('../server/controller.ts'),{Studio}=await import('../server/studio.ts');
 const {repositoryIdentity}=await import('../server/repository-resource.ts');
 class FakeRpc extends EventEmitter {
  calls:{method:string;params:any}[]=[];
  async initialize(){} async close(){this.emit('closed');}
  async request(method:string,params:any):Promise<any>{
   this.calls.push({method,params});
   if(method==='account/read')return {account:{type:'chatgpt'}};
   if(method==='config/read')return {config:{mcp_servers:{}}};
   if(method==='mcpServerStatus/list')return {data:[]};
   if(method==='thread/start'||method==='thread/resume')return {thread:{id:'worker-thread',status:{type:'idle'}},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
   if(method==='turn/start')return {turn:{id:'worker-turn'}};return {};
  }
 }
 const dir=mkdtempSync(join(tmpdir(),'orbit-scheduler-code-')),store=new Store(join(dir,'db.sqlite')),projects=new Projects(store,join(dir,'managed'),[],join(dir,'projects'));
 const {project,workspace}=projects.createProject({requestId:randomUUID(),name:'Code worker',kind:'code'});
 trustedGit(project.path,['checkout','-b','dev']);
 const rpc=new FakeRpc();
 const controller=new Controller(store,dir,()=>rpc,projects);
 await controller.selectWorkspace(workspace!.id);
  const studio=new Studio(store),input=JSON.parse(planningInput.text);input.requirements=[1,2,3].map(i=>({id:'R'+i,description:'Change file '+i,acceptance_criteria:['Keep existing behavior']}));
  const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{...planningInput,text:JSON.stringify(input)}}) as import('../shared/parallel.ts').PlanningVersion;
  const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as typeof draft;
  const tasks=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  new TaskGraphService(store).save(project.id,{planningVersionId:plan.id,contentHash:plan.contentHash,expectedRevision:0,nodes:tasks.map(t=>({taskId:t.id})),edges:[{taskId:tasks[2].id,dependsOn:tasks[0].id}]});
  const registry=discoverCapabilities({codexReady:true,probe:{checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.165.0'},claude:{status:'found',version:'2.1.312'}}});
  const execution=new CapabilityExecutionService(store,controller,()=>registry),routing=new CapabilityRoutingService(store);
  const plans=tasks.map(t=>execution.plan(project.id,{requestId:randomUUID(),routeId:routing.recommend(project.id,{requestId:randomUUID(),taskId:t.id,text:'코드 구현'},registry).id,workspaceId:workspace!.id}));
  const batch:ApprovedExecutionBatch={id:randomUUID(),projectId:project.id,planningVersionId:plan.id,planningHash:plan.contentHash,graphRevision:1,taskIds:tasks.map(t=>t.id),contractDigests:[],inputArtifactHashes:[],runtimeChoices:tasks.map(t=>({taskId:t.id,runtimeId:'codex'})),parallelLimit:2};
  const repositoryId=repositoryIdentity(join(project.path,'.git')).repositoryId;
  const progress=new ProjectProgressService(store,studio);
  const applied:any[]=[];
  store.db.exec('CREATE TABLE integration_queue(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,slot INTEGER UNIQUE CHECK(slot=1),body TEXT NOT NULL)');
  const reader={graph:(projectId:string,version:string)=>{
   const snapshot=progress.graph(projectId,version);
   for(const item of applied){
    const completion=snapshot.progress.tasks.find(t=>t.id===item.taskId)!.completion!;
    completion.verifiedDone=true;completion.binding.artifactId=item.space.workspaceId;completion.binding.artifactDigest=item.manifest.sourceDigest;
   }
   snapshot.state.nodes=snapshot.state.nodes.map(n=>n.taskId===tasks[2].id?{taskId:n.taskId,state:'ready'}:n);
   return snapshot;
  }};
  const scheduler=new WorkerScheduler(store,projects,execution,undefined,reader);
  const submit=(i:number)=>scheduler.submit({batch,executionId:plans[i].id,approval:{confirmed:true,expectedPlanDigest:plans[i].planDigest},claims:[{kind:'repository_file',repositoryId,path:resolveWorkerPath(project.path,`file-${i}.txt`),mode:'write'}]});

  function apply(taskIndex=0,file='parent.txt',bytes='parent',baseSha=workspace!.baseSha){
   const id=randomUUID(),target=inspectIntegrationTarget(project.path,'dev','main');
   const {candidate}=prepareIntegrationCandidate(project.path,baseSha,{sourceDigest:'a'.repeat(64),files:[{path:file,mode:'100644',presence:'present',bytes:Buffer.from(bytes)}]},target,id,dir);
   applyMergeCandidate(project.path,target,candidate);
   const item={id,taskId:tasks[taskIndex].id,projectId:project.id,fence:{reservationId:randomUUID()},status:'applied',released:true,targetBranch:'dev',defaultBranch:'main',candidate,
    space:{kind:'code',workspaceId:randomUUID()},manifest:{sourceDigest:createHash('sha256').update(id).digest('hex'),files:[{path:file,status:'present',sha256:createHash('sha256').update(bytes).digest('hex'),outOfScope:false}]}};
   applied.push(item);store.db.prepare('INSERT INTO integration_queue VALUES(?,?,?,NULL,?)').run(id,id,id,JSON.stringify(item));return item;
  }
  return {dir,store,projects,project,workspace:workspace!,controller,rpc,studio,tasks,plans,execution,batch,scheduler,submit,apply,applied,reader,
   async close(){await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('CQG-6b: same-batch dependent uses applied candidate, not plan base or later target HEAD',async()=>{
 const f=await codeFixture();try{
  const base=approvedWorkerBase(f.store,f.projects,f.batch,f.plans[0])!;
  const workers=new ParallelWorkerService(f.store),spaces=new WorkerSpaces(f.store,f.projects,workers);
  const r=workers.reserve({requestId:randomUUID(),ownerIncarnation:'test',batch:f.batch,attempt:{id:randomUUID(),taskId:f.tasks[0].id,runtimeId:'codex',dispatchRequestId:randomUUID()},claims:[{kind:'repository_file',repositoryId:base.repositoryId,path:resolveWorkerPath(f.project.path,'parent.txt'),mode:'write'}]});
  spaces.create(r,base);workers.release(r,{kind:'not_dispatched',dispatchRequestId:r.attempt.dispatchRequestId,evidenceId:'fixture'});
  const item=f.apply();
  trustedGit(f.project.path,['commit','--allow-empty','-m','unrelated later integration'],{identity:true});
  const result=await f.submit(2);assert.equal(result.state,'running');
  const run=f.store.findRequest(result.attempt.dispatchRequestId)!.run,worker=f.store.workspaces().find(w=>w.id===run.workspaceId)!;
  assert.equal(worker.baseSha,item.candidate.commitSha);assert.equal(readFileSync(join(worker.path,'parent.txt'),'utf8'),'parent');
  assert.equal(approvedWorkerBase(f.store,f.projects,f.batch,f.plans[0])!.baseSha,f.workspace.baseSha,'controller default stays plan-only');
  assert.equal(JSON.parse(String(f.store.db.prepare('SELECT body FROM worker_space_bases').get()!.body)).baseSha,f.workspace.baseSha);
  await f.submit(2);assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM worker_space_handoffs').get()!.count,1);
  writeFileSync(join(worker.path,'file-2.txt'),'dependent output');
  f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'worker-thread',turn:{id:'worker-turn',status:'completed'}}});await tick();f.scheduler.reconcile();
  assert.equal(f.scheduler.read(result.reservationId).state,'terminal_confirmed');
  const configuration=readVerificationConfiguration(JSON.stringify([{projectPath:f.project.path,id:'full',label:'Full',executable:process.execPath,args:['-e','process.exit(0)'],timeoutMs:10000,categories:[...CODE_GATES]}]));
  const verification=new VerificationService(f.store,f.projects,configuration),merge=new MergeService(f.store,f.projects,verification,()=>false);
  const policy:CompletionPolicy={projectKind:'code',requiredGates:[...CODE_GATES],gateCommandMap:verificationGateCommandMap(configuration,f.project.path),notApplicable:[],requireIndependentReview:false,dependencyRelease:'quality_passed'};
  let sourceBase:string|null=null;
  const queue=new IntegrationQueue(f.store,f.projects,workers,spaces,verification,merge,()=>({approvedBaseline:f.batch.planningHash,defaultBranch:'main',requiredChecks:['full'],completionPolicy:policy}),
   candidate=>candidateEvidence(candidate,f.store,policy,verificationCommandPreviews(configuration,f.project.path)),candidate=>{
    sourceBase=candidate.baseSha;
    const captured=candidateEvidence(candidate,f.store,policy,verificationCommandPreviews(configuration,f.project.path),true);
    const source=evaluateTaskCompletion(captured.evidence as CompletionEvidence,policy,captured.binding);
    source.binding={...source.binding,artifactId:candidate.space.workspaceId,artifactDigest:candidate.manifest.sourceDigest,baseSha:worker.baseSha};return source;
   });
  const queued=queue.enqueue({requestId:randomUUID(),fence:result,targetBranch:'dev'});await queue.drain();
  const integrated=queue.get(queued.id);
  assert.equal(integrated.status,'applied',integrated.reason??'');assert.equal(integrated.completion?.verifiedDone,true);
  assert.equal(sourceBase,item.candidate.commitSha,'candidate sourceBinding uses derived worker base');
  assert.equal(readFileSync(join(f.project.path,'file-2.txt'),'utf8'),'dependent output');
 }finally{await f.close();}
});
test('CQG-6b: rewritten target with identical bytes refuses before reservation',async()=>{
 const f=await codeFixture();try{
  const item=f.apply(),tree=trustedGit(f.project.path,['rev-parse','HEAD^{tree}']).toString().trim();
  const fork=trustedGit(f.project.path,['commit-tree',tree,'-p',f.workspace.baseSha],{identity:true,input:Buffer.from('rewritten target')}).toString().trim();
  trustedGit(f.project.path,['update-ref','refs/heads/dev',fork,item.candidate.commitSha]);
  assert.equal(isAncestor(f.project.path,item.candidate.commitSha,fork),false);
  await assert.rejects(f.submit(2),/WORKER_DEPENDENCY_OUTPUT_CHANGED/);assert.equal(f.scheduler.list().length,0);
  assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,0);
 }finally{await f.close();}
});
test('CQG-6b: incomparable direct predecessor commits refuse BASELINE_CHANGED',async()=>{
 const f=await codeFixture();try{
  const a=f.apply(),b=f.apply(1,'second.txt','second');
  const tree=trustedGit(f.project.path,['rev-parse','HEAD^{tree}']).toString().trim();
  b.candidate.commitSha=trustedGit(f.project.path,['commit-tree',tree,'-p',f.workspace.baseSha],{identity:true,input:Buffer.from('incomparable')}).toString().trim();
  f.store.db.prepare('UPDATE integration_queue SET body=? WHERE id=?').run(JSON.stringify(b),b.id);
  new TaskGraphService(f.store).save(f.project.id,{planningVersionId:f.batch.planningVersionId,contentHash:f.batch.planningHash,expectedRevision:1,nodes:f.tasks.map(t=>({taskId:t.id})),edges:[{taskId:f.tasks[2].id,dependsOn:f.tasks[0].id},{taskId:f.tasks[2].id,dependsOn:f.tasks[1].id}]});f.batch.graphRevision=2;
  assert.equal(isAncestor(f.project.path,a.candidate.commitSha,b.candidate.commitSha),false);
  await assert.rejects(f.submit(2),/WORKER_BASELINE_CHANGED/);assert.equal(f.scheduler.list().length,0);
 }finally{await f.close();}
});

test('CQG-6b: target branch not checked out refuses DEPENDENCY_OUTPUT_CHANGED before reservation',async()=>{
 const f=await codeFixture();try{
  f.apply();trustedGit(f.project.path,['checkout','-b','elsewhere']);
  await assert.rejects(f.submit(2),/WORKER_DEPENDENCY_OUTPUT_CHANGED/);assert.equal(f.scheduler.list().length,0);
  assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,0);
 }finally{await f.close();}
});
for(const commitSha of ['f'.repeat(40),'not-a-sha'])test(`CQG-6b: predecessor commit ${commitSha} refuses BASELINE_CHANGED before reservation`,async()=>{
 const f=await codeFixture();try{
  const item=f.apply();item.candidate.commitSha=commitSha;
  f.store.db.prepare('UPDATE integration_queue SET body=? WHERE id=?').run(JSON.stringify(item),item.id);
  await assert.rejects(f.submit(2),/WORKER_BASELINE_CHANGED/);assert.equal(f.scheduler.list().length,0);
  assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,0);
 }finally{await f.close();}
});
for(const change of ['identical bytes','different bytes','unrelated file'] as const)test(`CQG-6b: later applied integration with ${change}`,async()=>{
 const f=await codeFixture();try{
  const predecessor=f.apply();
  const later=f.apply(1,change==='unrelated file'?'unrelated.txt':'parent.txt',change==='identical bytes'?'parent':'later content',predecessor.candidate.commitSha);
  trustedGit(f.project.path,['merge-base','--is-ancestor',predecessor.candidate.commitSha,'refs/heads/dev']);
  assert.notEqual(later.candidate.commitSha,predecessor.candidate.commitSha);
  if(change==='different bytes'){
   await assert.rejects(f.submit(2),/WORKER_DEPENDENCY_OUTPUT_CHANGED/);
   assert.equal(f.scheduler.list().length,0);assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,0);
  }else{
   const r=await f.submit(2);assert.equal(r.state,'running');
   const space=JSON.parse(String(f.store.db.prepare('SELECT body FROM worker_spaces WHERE reservation_id=?').get(r.reservationId)!.body));
   assert.equal(space.baseSha,predecessor.candidate.commitSha);
   assert.equal(readFileSync(join(space.path,'parent.txt'),'utf8'),'parent');
   const pin=JSON.parse(String(f.store.db.prepare('SELECT body FROM worker_space_handoffs WHERE attempt_id=?').get(f.plans[2].id)!.body));
   assert.deepEqual(pin.handoff.predecessors.map((p:{integrationId:string})=>p.integrationId),[predecessor.id]);
   assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,1);
  }
 }finally{await f.close();}
});
