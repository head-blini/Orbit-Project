import {randomUUID} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import type {Store} from './store.ts';
import type {Projects} from './projects.ts';
import type {CapabilityExecutionService} from './capability-execution.ts';
import type {CapabilityExecutionApproval,CapabilityExecutionRecord} from '../shared/capability-execution.ts';
import type {ApprovedExecutionBatch,WorkerFence,WorkerReservation,WorkerResourceClaim} from '../shared/parallel-workers.ts';
import {ParallelWorkerService} from './parallel-workers.ts';
import {WorkerSpaces,resolveWorkerPath,type ApprovedWorkerBase,type WorkerSpace} from './worker-spaces.ts';
import {TaskGraphService} from './task-graph.ts';
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
 /** Trusted CQG adapter evidence for exactly this batch revision; today callers pass []. */
 verifiedDoneIds:string[];
}

/** The approved execution plan names the workspace; its persisted base is the source,
 * never current repository HEAD. PW-3 freezes this binding in worker_space_bases. */
export function approvedWorkerBase(store:Store,projects:Projects,batch:ApprovedExecutionBatch,plan:CapabilityExecutionRecord):ApprovedWorkerBase|undefined {
 const brief=new Studio(store).execution(batch.projectId,plan.taskId);
 if(brief.planningVersionId!==batch.planningVersionId||brief.planningContentHash!==batch.planningHash)fail('BASELINE_CHANGED');
 if(store.projects().find(p=>p.id===batch.projectId)?.kind!=='code')return;
 const workspace=store.workspaces().find(w=>w.id===plan.workspaceId&&w.projectId===batch.projectId);
 if(!workspace)fail('APPROVED_BASE_REQUIRED');
 const resource=projects.repositoryResource(workspace.id);
 if(resource.baseRevision!==workspace.baseSha)fail('BASELINE_CHANGED');
 return {batchId:batch.id,projectId:batch.projectId,repositoryId:resource.repositoryId,baseSha:workspace.baseSha};
}

/** Reuses PW-1 intent and CapabilityExecution's request journal. No timers, polling,
 * retry loop, quota expansion, automatic resume, or dispatch from a read. */
export class WorkerScheduler {
 private store:Store;private projects:Projects;private execution:CapabilityExecutionService;
 private workers:ParallelWorkerService;private spaces:WorkerSpaces;private graph:TaskGraphService;
 private owner=randomUUID();private quota:(runtimeId:string)=>'available'|'unknown'|'exhausted';
 constructor(store:Store,projects:Projects,execution:CapabilityExecutionService,quota:WorkerScheduler['quota']=()=> 'unknown'){
  this.store=store;this.projects=projects;this.execution=execution;this.quota=quota;
  this.workers=new ParallelWorkerService(store);this.spaces=new WorkerSpaces(store,projects,this.workers);this.graph=new TaskGraphService(store);
  // A new owner fences old callbacks. Even a reserved attempt is never replayed.
  for(const old of this.workers.list().filter(r=>r.state!=='released')){
   const r=this.workers.transfer(old,this.owner);
   if(!['terminal_confirmed','lost_unknown'].includes(r.state))this.workers.transition(r,'lost_unknown');
  }
  this.reconcile();
 }
 list(){return this.workers.list();}
 read(id:string){return this.workers.read(id);}
 private baseline(input:WorkerSubmission,plan:CapabilityExecutionRecord){
  const b=input.batch,g=this.graph.read(b.projectId,b.planningVersionId);
  if(g.revision!==b.graphRevision||g.contentHash!==b.planningHash||plan.projectId!==b.projectId||plan.baseline.planningVersionId!==b.planningVersionId||plan.baseline.planningContentHash!==b.planningHash
   ||!b.taskIds.includes(plan.taskId)||!b.runtimeChoices.some(c=>c.taskId===plan.taskId&&c.runtimeId===plan.runtimeId)||b.taskIds.some(id=>!g.nodes.some(n=>n.taskId===id)))fail('BASELINE_CHANGED');
  for(const contract of [...g.nodes,...g.edges].flatMap(n=>n.contracts??[]))if(!b.contractDigests.some(c=>c.id===contract.id&&c.digest===contract.digest))fail('CONTRACT_CHANGED');
  const state=this.graph.view(b.projectId,b.planningVersionId,{verifiedDoneIds:input.verifiedDoneIds,blocked:[]},b.graphRevision);
  if(state.stale)fail('BASELINE_CHANGED');
  if(state.nodes.find(n=>n.taskId===plan.taskId)?.state!=='ready')fail('DEPENDENCIES_WAITING');
  if(this.quota(plan.runtimeId)==='exhausted')fail('QUOTA_EXHAUSTED');
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
  this.baseline(input,plan);this.execution.assertWorkerPlan(b.projectId,plan.id,input.approval);
  const base=approvedWorkerBase(this.store,this.projects,b,plan);
  const r=this.workers.reserve({requestId:plan.requestId,ownerIncarnation:this.owner,batch:b,attempt:{id:plan.id,taskId:plan.taskId,runtimeId:plan.runtimeId,dispatchRequestId:plan.dispatchRequestId},claims:input.claims});
  const check=()=>{
   const latest=this.read(r.reservationId);
   if(latest.ownerIncarnation!==r.ownerIncarnation||latest.fencingGeneration!==r.fencingGeneration||!['reserved','dispatched','running'].includes(latest.state))fail('FENCE_STALE');
   this.baseline(input,plan);this.execution.assertWorkerPlan(b.projectId,plan.id,input.approval,plan);
   if(JSON.stringify(approvedWorkerBase(this.store,this.projects,b,plan))!==JSON.stringify(base))fail('BASELINE_CHANGED');
  };
  check();const space=this.spaces.create(r,base);check();
  const context:WorkerDispatchContext={fence:r,space,dispatchRequestId:plan.dispatchRequestId,beforeDispatch:()=>{
   check();const stat=lstatSync(space.path,{bigint:true});
   if(realpathSync(space.path)!==space.path||`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`!==space.identity)fail('SPACE_IDENTITY_CHANGED');
   if(space.workspaceId){
    const resource=this.projects.repositoryResource(space.workspaceId);
    if(resource.repositoryId!==space.repositoryId||resource.baseRevision!==space.baseSha||resource.worktreePath!==space.path)fail('SPACE_IDENTITY_CHANGED');
   }
   for(const claim of r.claims){
    if(claim.kind==='repository_file'||claim.kind==='isolated_folder'||claim.kind==='db_file_group'){
     const path=resolveWorkerPath(space.path,claim.path.path,claim.kind!=='repository_file');
     if(JSON.stringify(path)!==JSON.stringify(claim.path))fail('SPACE_IDENTITY_CHANGED');
    }
   }
  }};
  this.workers.transition(r,'dispatched');context.beforeDispatch();
  await this.execution.start(b.projectId,plan.id,input.approval,context);
  const current=this.read(r.reservationId);
  if(current.ownerIncarnation===this.owner&&current.state==='dispatched'){
   const receipt=this.store.findRequest(plan.dispatchRequestId)?.run;
   // Adapters record the Run before any process starts; no receipt after start returned means nothing was dispatched.
   // A space that no longer verifies stays quarantined (lost_unknown) for inspection instead of being freed.
   const intact=()=>{try{context.beforeDispatch();return true;}catch{return false;}};
   if(!receipt&&intact())this.workers.release(this.workers.confirmTerminal(current,{kind:'terminal_confirmed',dispatchRequestId:plan.dispatchRequestId,evidenceId:plan.id}));
   else this.workers.transition(current,receipt&&receipt.execution!=='lost'?'running':'lost_unknown');
  }
  this.reconcile();return this.read(r.reservationId);
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
