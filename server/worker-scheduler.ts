import {ProjectProgressService} from './project-progress.ts';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {IntegrationItem} from './integration-queue.ts';
import type {Store} from './store.ts';
import type {Projects} from './projects.ts';
import type {CapabilityExecutionService} from './capability-execution.ts';
import type {CapabilityExecutionApproval,CapabilityExecutionRecord} from '../shared/capability-execution.ts';
import type {ApprovedExecutionBatch,WorkerFence,WorkerReservation,WorkerResourceClaim} from '../shared/parallel-workers.ts';
import {ParallelWorkerService} from './parallel-workers.ts';
import {WorkerSpaces,resolveWorkerPath,type ApprovedWorkerBase,type WorkerHandoff,type WorkerSpace} from './worker-spaces.ts';
import {isAncestor,inspectIntegrationTarget} from './merge-git.ts';
import {Studio} from './studio.ts';
import {AppError} from './errors.ts';

function fail(code:string):never {throw new AppError('WORKER_'+code,409);}
/** Internal server capability. Never deserialize this object from an HTTP request. */
export interface WorkerDispatchContext {
 fence:WorkerFence;space:WorkerSpace;dispatchRequestId:string;
 beforeDispatch:()=>void;
}
/** Legacy entry points cannot bypass a durable worker reservation for this task. */
export function assertWorkerOwnership(store:Store,projectId:string,taskId:string,worker?:WorkerDispatchContext):void {
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_reservations'").get()){
  if(worker)fail('CONTEXT_REQUIRED');return;
 }
 const held=store.db.prepare("SELECT body FROM worker_reservations WHERE json_extract(body,'$.batch.projectId')=? AND json_extract(body,'$.attempt.taskId')=? AND json_extract(body,'$.state')!='released'").all(projectId,taskId).map(row=>JSON.parse(String(row.body)) as WorkerReservation);
 if(held.length&&(!worker||held.length!==1||held[0].reservationId!==worker.fence.reservationId||held[0].attempt.dispatchRequestId!==worker.dispatchRequestId))fail('CONTEXT_REQUIRED');
 if(worker){if(!held.length)fail('CONTEXT_REQUIRED');worker.beforeDispatch();}
}
export interface WorkerSubmission {
 batch:ApprovedExecutionBatch;executionId:string;approval:CapabilityExecutionApproval;
 claims:WorkerResourceClaim[];
}

/** The approved execution plan names the workspace; its persisted base is the source,
 * never current repository HEAD. PW-3 freezes this binding in worker_space_bases. */
export function approvedWorkerBase(store:Store,projects:Projects,batch:ApprovedExecutionBatch,plan:CapabilityExecutionRecord,handoff?:WorkerHandoff):ApprovedWorkerBase|undefined {
 const brief=new Studio(store).execution(batch.projectId,plan.taskId);
 if(brief.planningVersionId!==batch.planningVersionId||brief.planningContentHash!==batch.planningHash)fail('BASELINE_CHANGED');
 if(store.projects().find(p=>p.id===batch.projectId)?.kind!=='code')return;
 const workspace=store.workspaces().find(w=>w.id===plan.workspaceId&&w.projectId===batch.projectId);
 if(!workspace)fail('APPROVED_BASE_REQUIRED');
 const resource=projects.repositoryResource(workspace.id);
 if(resource.baseRevision!==workspace.baseSha)fail('BASELINE_CHANGED');
 let baseSha=workspace.baseSha;
 if(handoff?.predecessors.length){
  const project=store.projects().find(p=>p.id===batch.projectId)!;
  const items=store.db.prepare('SELECT body FROM integration_queue').all().map(row=>JSON.parse(String(row.body)) as IntegrationItem);
  const predecessors=handoff.predecessors.map(p=>{
   const matches=items.filter(item=>item.id===p.integrationId&&item.projectId===batch.projectId&&item.status==='applied'&&item.released===true&&item.candidate?.commitSha===p.commitSha);
   if(matches.length!==1||!p.commitSha)fail('DEPENDENCY_OUTPUT_NOT_INTEGRATED');return matches[0];
  });
  // The newest direct predecessor is the one containing every other predecessor.
  // Never derive the base from the moving target ref.
  // Git refusals (missing object, malformed SHA, unavailable/moved target) fail closed as typed scheduler codes.
  const git=<T>(code:string,work:()=>T):T=>{try{return work();}catch{return fail(code);}};
  const ancestor=(a:string,b:string)=>git('BASELINE_CHANGED',()=>isAncestor(project.path,a,b));
  const latest=predecessors.find(item=>predecessors.every(other=>ancestor(other.candidate!.commitSha,item.candidate!.commitSha)));
  if(!latest||!ancestor(workspace.baseSha,latest.candidate!.commitSha))fail('BASELINE_CHANGED');
  baseSha=latest.candidate!.commitSha;
  for(const item of predecessors){
   if(!item.targetBranch||item.targetBranch!==latest.targetBranch)fail('BASELINE_CHANGED');
   if(!git('DEPENDENCY_OUTPUT_CHANGED',()=>isAncestor(project.path,baseSha,inspectIntegrationTarget(project.path,item.targetBranch!,item.defaultBranch).head)))fail('DEPENDENCY_OUTPUT_CHANGED');
  }
 }
 return {batchId:batch.id,projectId:batch.projectId,repositoryId:resource.repositoryId,baseSha};
}

/** Reuses PW-1 intent and CapabilityExecution's request journal. No timers, polling,
 * retry loop, quota expansion, automatic resume, or dispatch from a read. */
export class WorkerScheduler {
 private store:Store;private projects:Projects;private execution:CapabilityExecutionService;
 private completion:Pick<ProjectProgressService,'graph'>;
 private workers:ParallelWorkerService;private spaces:WorkerSpaces;
 private owner=randomUUID();private quota:(runtimeId:string)=>'available'|'unknown'|'exhausted';
 constructor(store:Store,projects:Projects,execution:CapabilityExecutionService,quota:WorkerScheduler['quota']=()=> 'unknown',completion?:Pick<ProjectProgressService,'graph'>){
  this.completion=completion??new ProjectProgressService(store,new Studio(store));
  this.store=store;this.projects=projects;this.execution=execution;this.quota=quota;
  this.workers=new ParallelWorkerService(store);this.spaces=new WorkerSpaces(store,projects,this.workers);
  // A new owner fences old callbacks. Even a reserved attempt is never replayed.
  for(const old of this.workers.list().filter(r=>r.state!=='released')){
   const r=this.workers.transfer(old,this.owner);
   if(!['terminal_confirmed','lost_unknown'].includes(r.state))this.workers.transition(r,'lost_unknown');
  }
  this.reconcile();
 }
 list(){return this.workers.list();}
 read(id:string){return this.workers.read(id);}
 private baseline(input:WorkerSubmission,plan:CapabilityExecutionRecord,space?:WorkerSpace):WorkerHandoff{
  const b=input.batch,snapshot=this.completion.graph(b.projectId,b.planningVersionId),g=snapshot.graph;
  if(g.revision!==b.graphRevision||g.contentHash!==b.planningHash||plan.projectId!==b.projectId||plan.baseline.planningVersionId!==b.planningVersionId||plan.baseline.planningContentHash!==b.planningHash
   ||!b.taskIds.includes(plan.taskId)||!b.runtimeChoices.some(c=>c.taskId===plan.taskId&&c.runtimeId===plan.runtimeId)||b.taskIds.some(id=>!g.nodes.some(n=>n.taskId===id)))fail('BASELINE_CHANGED');
  for(const contract of [...g.nodes,...g.edges].flatMap(n=>n.contracts??[]))if(!b.contractDigests.some(c=>c.id===contract.id&&c.digest===contract.digest))fail('CONTRACT_CHANGED');
  const state=snapshot.state;
  if(state.stale)fail('BASELINE_CHANGED');
  if(state.nodes.find(n=>n.taskId===plan.taskId)?.state!=='ready')fail('DEPENDENCIES_WAITING');
  const handoff:WorkerHandoff={predecessors:[]};
  for(const edge of g.edges.filter(e=>e.taskId===plan.taskId)){
   const completion=snapshot.progress.tasks.find(t=>t.id===edge.dependsOn)?.completion;
   if(!completion?.verifiedDone)fail('DEPENDENCIES_WAITING');
   const rows=this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='integration_queue'").get()
    ?this.store.db.prepare('SELECT body FROM integration_queue').all():[];
   const applied=rows.map(row=>JSON.parse(String(row.body)) as IntegrationItem).filter(item=>item.projectId===b.projectId&&item.status==='applied'
    &&(item.space.workspaceId===completion.binding.artifactId||item.space.attemptId===completion.binding.artifactId));
   if(applied.length!==1)fail('DEPENDENCY_OUTPUT_NOT_INTEGRATED');
   if(applied[0].released!==true)fail('DEPENDENCY_OUTPUT_NOT_INTEGRATED');
   const item=applied[0],hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
   if((item.space.kind==='code'?item.manifest.sourceDigest:hash(item.manifest))!==completion.binding.artifactDigest)fail('DEPENDENCY_OUTPUT_CHANGED');
   const project=this.store.projects().find(p=>p.id===b.projectId)!;
   const predecessor:WorkerHandoff['predecessors'][number]={taskId:edge.dependsOn,integrationId:item.id,commitSha:item.candidate?.commitSha??null,files:[]};
   for(const file of item.manifest.files){
    if(file.status!=='present'||!file.sha256||file.outOfScope)fail('DEPENDENCY_OUTPUT_UNAVAILABLE');
    const verify=(root:string,path:string)=>{
     try{const resolved=resolveWorkerPath(root,path);
      if(createHash('sha256').update(readFileSync(join(root,resolved.canonicalPath))).digest('hex')!==file.sha256)fail('DEPENDENCY_OUTPUT_CHANGED');
     }catch{fail('DEPENDENCY_OUTPUT_CHANGED');}
    };
    verify(project.path,file.path);
    // Both project bytes and the frozen worker input must still match completion evidence.
    if(space)verify(space.path,space.kind==='code'?file.path:join('inputs',file.path));
    predecessor.files.push({path:file.path,sha256:file.sha256});
   }
   handoff.predecessors.push(predecessor);
  }
  if(this.quota(plan.runtimeId)==='exhausted')fail('QUOTA_EXHAUSTED');
  return handoff;
 }
 async submit(raw:WorkerSubmission):Promise<WorkerReservation>{
  const input=structuredClone(raw),b=input.batch;
  const plan=this.execution.record(b.projectId,input.executionId);
  if(input.approval.confirmed!==true||input.approval.expectedPlanDigest!==plan.planDigest)fail('APPROVAL_REQUIRED');
  const prior=this.list().find(r=>r.requestId===plan.requestId);
  if(prior){
   if(JSON.stringify(prior.batch)!==JSON.stringify(b)||JSON.stringify(prior.claims)!==JSON.stringify(input.claims)||prior.attempt.id!==plan.id)fail('IDEMPOTENCY_CONFLICT');
   return prior;
  }
  if(plan.status!=='awaiting_approval')fail('EXECUTION_ALREADY_STARTED');
  const handoff=this.baseline(input,plan);this.execution.assertWorkerPlan(b.projectId,plan.id,input.approval);
  const base=approvedWorkerBase(this.store,this.projects,b,plan,handoff);
  const r=this.workers.reserve({requestId:plan.requestId,ownerIncarnation:this.owner,batch:b,attempt:{id:plan.id,taskId:plan.taskId,runtimeId:plan.runtimeId,dispatchRequestId:plan.dispatchRequestId},claims:input.claims});
  let space:WorkerSpace|undefined;
  const check=()=>{
   const latest=this.read(r.reservationId);
   if(latest.ownerIncarnation!==r.ownerIncarnation||latest.fencingGeneration!==r.fencingGeneration||!['reserved','dispatched','running'].includes(latest.state))fail('FENCE_STALE');
   const currentHandoff=this.baseline(input,plan,space);
   if(JSON.stringify(currentHandoff)!==JSON.stringify(handoff))fail('DEPENDENCY_OUTPUT_CHANGED');
   this.execution.assertWorkerPlan(b.projectId,plan.id,input.approval,plan);
   if(JSON.stringify(approvedWorkerBase(this.store,this.projects,b,plan,currentHandoff))!==JSON.stringify(base))fail('BASELINE_CHANGED');
  };
  try{
  check();space=this.spaces.create(r,base,handoff);check();
  const readySpace=space;
  const context:WorkerDispatchContext={fence:r,space:readySpace,dispatchRequestId:plan.dispatchRequestId,beforeDispatch:()=>{
   check();const stat=lstatSync(readySpace.path,{bigint:true});
   if(realpathSync(readySpace.path)!==readySpace.path||`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`!==readySpace.identity)fail('SPACE_IDENTITY_CHANGED');
   if(readySpace.workspaceId){
    const resource=this.projects.repositoryResource(readySpace.workspaceId);
    if(resource.repositoryId!==readySpace.repositoryId||resource.baseRevision!==readySpace.baseSha||resource.worktreePath!==readySpace.path)fail('SPACE_IDENTITY_CHANGED');
   }
   for(const claim of r.claims){
    if(claim.kind==='repository_file'||claim.kind==='isolated_folder'||claim.kind==='db_file_group'){
     const path=resolveWorkerPath(readySpace.path,claim.path.path,claim.kind!=='repository_file');
     if(JSON.stringify(path)!==JSON.stringify(claim.path))fail('SPACE_IDENTITY_CHANGED');
    }
   }
  }};
  context.beforeDispatch();
  await this.execution.start(b.projectId,plan.id,input.approval,context);
  if(this.store.findRequest(plan.dispatchRequestId))this.workers.transition(r,'dispatched');
  const current=this.read(r.reservationId);
  if(current.state==='reserved'){
   let safe=true;try{context.beforeDispatch();}catch(error){safe=error instanceof AppError&&/^WORKER_(?:BASELINE_CHANGED|DEPENDENCIES_WAITING|DEPENDENCY_)/.test(error.message);}
   if(safe)this.workers.release(current,{kind:'not_dispatched',dispatchRequestId:plan.dispatchRequestId,evidenceId:plan.id});
   else this.workers.transition(current,'lost_unknown');
  }
  if(current.ownerIncarnation===this.owner&&current.state==='dispatched'){
   const receipt=this.store.findRequest(plan.dispatchRequestId)?.run;
   // Adapters record the Run before any process starts; no receipt after start returned means nothing was dispatched.
   // A space that no longer verifies stays quarantined (lost_unknown) for inspection instead of being freed.
   const intact=()=>{try{context.beforeDispatch();return true;}catch{return false;}};
   if(!receipt&&intact())this.workers.release(this.workers.confirmTerminal(current,{kind:'terminal_confirmed',dispatchRequestId:plan.dispatchRequestId,evidenceId:plan.id}));
   else this.workers.transition(current,receipt&&receipt.execution!=='lost'?'running':'lost_unknown');
  }
  this.reconcile();return this.read(r.reservationId);
  }catch(error){
   const current=this.read(r.reservationId);
   if(current.state==='reserved'&&!this.store.findRequest(plan.dispatchRequestId)&&error instanceof AppError&&/^WORKER_(?:BASELINE_CHANGED|DEPENDENCIES_WAITING|DEPENDENCY_)/.test(error.message))this.workers.release(current,{kind:'not_dispatched',dispatchRequestId:plan.dispatchRequestId,evidenceId:plan.id});
   throw error;
  }
 }
 reconcile():void {
  for(const r of this.list()){
   if(['released','terminal_confirmed','reserved'].includes(r.state))continue;
   const receipt=this.execution.workerTerminalReceipt(r.batch.projectId,r.attempt.id,r.reservationId);
   if(receipt)this.workers.confirmTerminal(r,{kind:'terminal_confirmed',dispatchRequestId:r.attempt.dispatchRequestId,evidenceId:receipt.id});
   else if(this.store.findRequest(r.attempt.dispatchRequestId)?.run.execution==='lost'&&r.state!=='lost_unknown')this.workers.transition(r,'lost_unknown');
  }
 }
 /** Explicit handoff only; terminal workers retain claims until integration accepts ownership. */
 release(id:string):WorkerReservation {
  this.reconcile();const r=this.read(id);
  if(!this.execution.workerTerminalReceipt(r.batch.projectId,r.attempt.id,r.reservationId))fail('TERMINAL_REQUIRED');
  return this.workers.release(r);
 }
}
