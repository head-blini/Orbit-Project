import {assertWorkerOwnership,type WorkerDispatchContext} from './worker-scheduler.ts';
import {providerExecutionEvidence} from './provider-evidence.ts';
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import type {Controller} from './controller.ts';
import type {OrchestrationRegistry} from '../shared/capability-orchestration.ts';
import type {CapabilityPlanInput,CapabilityExecutionApproval,CapabilityExecutionRecord} from '../shared/capability-execution.ts';
import type {QualityLoopStart,QualityLoopRecord,QualitySelection} from '../shared/quality-loop-record.ts';
import type {QualityLoopInput} from '../shared/quality-loop.ts';
import {CapabilityRoutingService} from './capability-routing.ts';
import {CapabilityRuntimeAdapters} from './capability-runtime-adapters.ts';
import {ProjectAiPreferencesService} from './project-ai-preferences.ts';
import {Studio,exact} from './studio.ts';
import {qualityRunEvidence} from './quality-loop-native.ts';
import {containsCredential} from './privacy.ts';
import {AppError} from './errors.ts';
import {generalAcceptance} from './acceptance.ts';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validId=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(v)&&!containsCredential(v);
function fail(code:string):never{throw new AppError(code,409);}
const unknownModels=()=>({selectedModelId:null,requestedModelId:null,serverModelId:null,actualModelId:'unknown',source:'unknown' as const});
function terminalDispatch(store:Store,record:CapabilityExecutionRecord){
 const run=store.findRequest(record.dispatchRequestId)?.run;
 if(!run||run.requestId!==record.dispatchRequestId||record.runId!==null&&record.runId!==run.id
  ||run.taskId!==record.taskId||(run.runtime??'codex')!==record.runtimeId||(run.workspaceId??null)!==record.workspaceId
  ||(run.projectId??store.workspaces().find(workspace=>workspace.id===run.workspaceId)?.projectId)!==record.projectId
  ||run.planningVersionId!==record.baseline.planningVersionId||run.planningContentHash!==record.baseline.planningContentHash
  ||(run.acceptanceDigest??null)!==record.expectedAcceptanceDigest||!['completed','failed','interrupted'].includes(run.execution))return null;
 return run;
}


/** Owns the plan/approval journal only. Controller and QualityLoopService own all execution. */
export class CapabilityExecutionService {
 private store:Store;private controller:Controller;private registry:()=>OrchestrationRegistry;private adapters:CapabilityRuntimeAdapters;
 private routing:CapabilityRoutingService;private studio:Studio;private prefs:ProjectAiPreferencesService;
 /** Native probe refresh (capability-probe.ts): local `--version` only, never a prompt, model turn, auth or quota. A fresh cache is a no-op. */
 readonly refreshProbe:()=>Promise<unknown>;
 constructor(store:Store,controller:Controller,registry:()=>OrchestrationRegistry,adapters=new CapabilityRuntimeAdapters(controller),refreshProbe:()=>Promise<unknown>=async()=>{}){
  this.store=store;this.controller=controller;this.registry=registry;this.adapters=adapters;this.refreshProbe=refreshProbe;
  this.routing=new CapabilityRoutingService(store);this.studio=new Studio(store);this.prefs=new ProjectAiPreferencesService(store);
  store.db.exec('CREATE TABLE IF NOT EXISTS capability_executions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,body TEXT NOT NULL)');
  for(const row of store.db.prepare('SELECT body FROM capability_executions').all()){
   const r=JSON.parse(String(row.body)) as CapabilityExecutionRecord;
   if(['dispatching','running','interrupt_requested','recovery_required'].includes(r.status)){
    const run=terminalDispatch(store,r);
    if(run){r.runId=run.id;r.recoveryRequired=false;r.issue=null;r.status=run.execution==='completed'?'execution_completed':run.execution==='failed'?'failed':'interrupted';}
    else{r.recoveryRequired=true;r.status='recovery_required';r.issue='EXECUTION_RESTART_RECOVERY_REQUIRED';}
    this.save(r);
   }
  }
 }
 private raw(projectId:string,id:string):CapabilityExecutionRecord {
  const row=this.store.db.prepare('SELECT body FROM capability_executions WHERE id=? AND project_id=?').get(id,projectId);
  if(!row)throw new AppError('CAPABILITY_EXECUTION_NOT_FOUND',404);return JSON.parse(String(row.body));
 }
 private save(record:CapabilityExecutionRecord){
  record.updatedAt=new Date().toISOString();this.store.transaction(()=>{
   this.store.db.prepare('UPDATE capability_executions SET body=? WHERE id=?').run(JSON.stringify(record),record.id);
   this.store.append('capability.execution',record.runId,{projectId:record.projectId,taskId:record.taskId,executionId:record.id,status:record.status,issue:record.issue});
  });
 }
 private taskBlocked(projectId:string,taskId:string,excludeId?:string){
  return this.store.db.prepare("SELECT id FROM capability_executions WHERE project_id=? AND json_extract(body,'$.taskId')=?").all(projectId,taskId).some(row=>{
   if(row.id===excludeId)return false;const record=this.record(projectId,String(row.id));
   return record.recoveryRequired||['dispatching','running','interrupt_requested'].includes(record.status);
  });
 }
 records(projectId:string){this.routing.records(projectId);return this.store.db.prepare('SELECT id FROM capability_executions WHERE project_id=? ORDER BY rowid DESC LIMIT 200').all(projectId).map(row=>this.record(projectId,String(row.id)));}
 record(projectId:string,id:string){return readCapabilityExecution(this.store,projectId,id);}
 private binding(projectId:string,input:CapabilityPlanInput,worker=false){
  const route=this.routing.records(projectId).find(r=>r.id===input.routeId);
  if(!route||route.status!=='recommended'||route.intent!=='execution'||!route.runtimeId)fail('ROUTE_NOT_EXECUTABLE');
  const brief=this.studio.execution(projectId,route.taskId),prefs=this.prefs.read(projectId),registry=this.registry();
  if(route.baseline.planningVersionId!==brief.planningVersionId||route.baseline.planningContentHash!==brief.planningContentHash||route.preferencesRevision!==prefs.revision||route.runtimeId!==prefs.execution)fail('PLAN_CHANGED');
  const provider=registry.providers.find(p=>p.runtimeId===route.runtimeId),capability=provider?.capabilities.find(c=>c.id===route.capabilityId);
  if(capability?.implementation!=='implemented'||capability.policy!=='allowed')fail('CAPABILITY_BLOCKED');
  const adapter=this.adapters.snapshot(route.runtimeId,provider?.version??null);
  if(!adapter.compatible)fail(adapter.issue??'RUNTIME_VERSION_UNSUPPORTED');
  if(!route.capabilityId||!adapter.capabilities.includes(route.capabilityId))fail('CAPABILITY_NOT_IMPLEMENTED');
  const project=this.store.projects().find(p=>p.id===projectId)!;
  if(project.kind==='code'){
   if(!input.workspaceId)fail('WORKSPACE_REQUIRED');
   const preview=this.controller.taskVerificationPreview(projectId,route.taskId,input.workspaceId!,worker);
   if(preview?.digest!==input.expectedAcceptanceDigest)fail('ACCEPTANCE_PREVIEW_STALE');
  }else{
   if(input.workspaceId!==undefined)fail('INVALID_FIELDS');
   // Legacy records without a digest stay blocked; never auto-fill them here.
   if(input.expectedAcceptanceDigest===undefined)fail('PLAN_CHANGED');
   if(generalAcceptance(this.store,projectId,route.taskId).digest!==input.expectedAcceptanceDigest)fail('ACCEPTANCE_PREVIEW_STALE');
  }
  // Probe time is not plan content: a re-probe with unchanged versions/capabilities keeps the approval valid.
  return {route,adapter,bindingDigest:hash({brief,prefs,registry:{...registry,observedAt:null},adapter,workspaceId:input.workspaceId??null,acceptance:input.expectedAcceptanceDigest??null})};
 }
 plan(projectId:string,input:CapabilityPlanInput):CapabilityExecutionRecord {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('INVALID_FIELDS',400);
  exact(input as unknown as Record<string,unknown>,['requestId','routeId',...(Object.hasOwn(input,'workspaceId')?['workspaceId']:[]),...(Object.hasOwn(input,'expectedAcceptanceDigest')?['expectedAcceptanceDigest']:[])]);
  if(!validId(input.requestId)||!validId(input.routeId)||input.workspaceId!==undefined&&!validId(input.workspaceId)||input.expectedAcceptanceDigest!==undefined&&!/^[a-f0-9]{64}$/.test(input.expectedAcceptanceDigest))throw new AppError('INVALID_FIELDS',400);
  const key=hash({projectId,input}),prior=this.store.db.prepare('SELECT input_digest,body FROM capability_executions WHERE request_id=?').get(input.requestId);
  if(prior){if(prior.input_digest!==key)fail('IDEMPOTENCY_CONFLICT');return this.record(projectId,(JSON.parse(String(prior.body)) as CapabilityExecutionRecord).id);}
  if(this.store.projects().find(p=>p.id===projectId)?.kind==='code'&&input.workspaceId===undefined){
   const workspaceId=this.controller.snapshot().selectedWorkspaceId;
   if(!workspaceId)fail('WORKSPACE_REQUIRED');
   const route=this.routing.records(projectId).find(r=>r.id===input.routeId);if(!route)fail('ROUTE_NOT_EXECUTABLE');
   const preview=this.controller.taskVerificationPreview(projectId,route.taskId,workspaceId);
   input={...input,workspaceId,...(preview?{expectedAcceptanceDigest:preview.digest}:{})};
  }else if(this.store.projects().find(p=>p.id===projectId)?.kind==='general'&&input.expectedAcceptanceDigest===undefined){
   const route=this.routing.records(projectId).find(r=>r.id===input.routeId);if(!route)fail('ROUTE_NOT_EXECUTABLE');
   input={...input,expectedAcceptanceDigest:generalAcceptance(this.store,projectId,route.taskId).digest};
  }
  const {route,adapter,bindingDigest}=this.binding(projectId,input);
  if(this.taskBlocked(projectId,route.taskId))fail('EXECUTION_RECOVERY_REQUIRED');
  const now=new Date().toISOString(),id=randomUUID();
  const record:CapabilityExecutionRecord={id,requestId:input.requestId,projectId,taskId:route.taskId,routeId:route.id,runtimeId:route.runtimeId!,createdAt:now,updatedAt:now,
   planDigest:hash({id,bindingDigest}),bindingDigest,dispatchRequestId:randomUUID(),workspaceId:input.workspaceId??null,expectedAcceptanceDigest:input.expectedAcceptanceDigest??null,
   baseline:route.baseline,preferencesRevision:route.preferencesRevision,adapter,status:'awaiting_approval',issue:null,runId:null,qualityLoopId:null,recoveryRequired:false,approvedAt:null,
   executionScope:'approved_task',validationSource:'runtime_evidence_required',models:unknownModels(),quality:null};
  this.store.transaction(()=>{this.store.db.prepare('INSERT INTO capability_executions VALUES(?,?,?,?,?)').run(id,projectId,input.requestId,key,JSON.stringify(record));this.store.append('capability.plan',null,{projectId,taskId:record.taskId,executionId:id});});return record;
 }
 assertWorkerPlan(projectId:string,id:string,approval:CapabilityExecutionApproval,original?:CapabilityExecutionRecord){
  const r=original??this.raw(projectId,id);
  if(approval.confirmed!==true||approval.expectedPlanDigest!==r.planDigest)fail('PLAN_CHANGED');
  const current=this.binding(projectId,{requestId:r.requestId,routeId:r.routeId,...(r.workspaceId?{workspaceId:r.workspaceId}:{}),...(r.expectedAcceptanceDigest?{expectedAcceptanceDigest:r.expectedAcceptanceDigest}:{})},true);
  if(current.bindingDigest!==r.bindingDigest)fail('PLAN_CHANGED');
 }
 workerTerminalReceipt(projectId:string,id:string,reservationId:string){
  const r=this.raw(projectId,id) as CapabilityExecutionRecord&{workerReservationId?:string};
  return r.workerReservationId===reservationId?terminalDispatch(this.store,r):null;
 }
 async start(projectId:string,id:string,input:CapabilityExecutionApproval,worker?:WorkerDispatchContext){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('INVALID_FIELDS',400);
  exact(input as unknown as Record<string,unknown>,['confirmed','expectedPlanDigest']);
  if(input.confirmed!==true)fail('EXECUTION_CONFIRMATION_REQUIRED');
  await this.refreshProbe();
  const r=this.raw(projectId,id) as CapabilityExecutionRecord&{workerReservationId?:string};if(input.expectedPlanDigest!==r.planDigest)fail('PLAN_CHANGED');
  if(r.status!=='awaiting_approval')return this.record(projectId,id);
  assertWorkerOwnership(this.store,projectId,r.taskId,worker);
  // General runs bind the digest server-side (ClaudeTaskService); their submit payload stays requestId-only.
  let submit={requestId:r.dispatchRequestId,...(r.workspaceId?{workspaceId:r.workspaceId}:{}),...(r.workspaceId&&r.expectedAcceptanceDigest?{expectedAcceptanceDigest:r.expectedAcceptanceDigest}:{})};
  const current=this.binding(projectId,{requestId:r.requestId,routeId:r.routeId,...(r.workspaceId?{workspaceId:r.workspaceId}:{}),...(r.expectedAcceptanceDigest?{expectedAcceptanceDigest:r.expectedAcceptanceDigest}:{})},!!worker);
  if(current.bindingDigest!==r.bindingDigest)fail('PLAN_CHANGED');
  if(this.taskBlocked(projectId,r.taskId,id))fail('EXECUTION_RECOVERY_REQUIRED');
  if(worker){worker.beforeDispatch();if(worker.dispatchRequestId!==r.dispatchRequestId)fail('WORKER_REQUEST_MISMATCH');r.workerReservationId=worker.fence.reservationId;}
  r.status='dispatching';r.approvedAt=new Date().toISOString();this.save(r);
  try{
   // Store observers can change policy synchronously; recheck immediately before dispatch.
   if(this.binding(projectId,{requestId:r.requestId,routeId:r.routeId,...(r.workspaceId?{workspaceId:r.workspaceId}:{}),...(r.expectedAcceptanceDigest?{expectedAcceptanceDigest:r.expectedAcceptanceDigest}:{})},!!worker).bindingDigest!==r.bindingDigest)fail('PLAN_CHANGED');
  }catch{r.status='failed';r.issue='EXECUTION_PREFLIGHT_CHANGED';this.save(r);return this.record(projectId,id);}
  let returned=false;
  try{
   if(worker){
    worker.beforeDispatch();
    if(worker.space.kind==='code'){
     await this.controller.prepareWorkerWorkspace(worker);
     await this.refreshProbe();worker.beforeDispatch();
     r.workspaceId=worker.space.workspaceId;
     r.expectedAcceptanceDigest=this.controller.taskVerificationPreview(projectId,r.taskId,r.workspaceId!)?.digest??null;
     submit={requestId:r.dispatchRequestId,workspaceId:r.workspaceId!,...(r.expectedAcceptanceDigest?{expectedAcceptanceDigest:r.expectedAcceptanceDigest}:{})};
     this.save(r);
    }
   }
   const run=await this.adapters.dispatch(r.runtimeId,projectId,r.taskId,submit,worker);returned=true;
   const receipt=this.store.findRequest(r.dispatchRequestId)?.run;
   if(!receipt||receipt.id!==run.id||receipt.taskId!==r.taskId||receipt.planningVersionId!==r.baseline.planningVersionId||receipt.planningContentHash!==r.baseline.planningContentHash
    ||(receipt.acceptanceDigest??null)!==r.expectedAcceptanceDigest)fail('EXECUTION_RECEIPT_MISMATCH');
   r.runId=receipt.id;r.status='running';this.save(r);
  }catch(error){
   // Adapters record the Run before any process starts (Controller.start, ClaudeTaskService.submit). A typed refusal raised
   // before dispatch returned, with no request recorded, launched nothing: a clean, retryable failure. Anything else stays unconfirmed.
   if(!returned&&error instanceof AppError&&error.status<500&&!this.store.findRequest(r.dispatchRequestId)){r.status='failed';r.issue='EXECUTION_PREFLIGHT_CHANGED';this.save(r);return this.record(projectId,id);}
   r.runId=this.store.findRequest(r.dispatchRequestId)?.run.id??null;r.status='recovery_required';r.issue='EXECUTION_DISPATCH_UNCONFIRMED';r.recoveryRequired=true;this.save(r);
  }
  return this.record(projectId,id);
 }
 async interrupt(projectId:string,id:string){
  const r=this.record(projectId,id);if(!r.runId)fail('EXECUTION_UNCONFIRMED');
  if(['interrupted','failed','execution_completed','quality_passed','quality_failed','quality_blocked'].includes(r.status))return r;
  if(r.quality&&r.status==='quality_running'){this.controller.qualityLoops.interrupt(r.quality.id);return this.record(projectId,id);}
  await this.adapters.interrupt(r.runtimeId,r.runId!);return this.record(projectId,id);
 }
 async recover(projectId:string,id:string){
  const r=this.raw(projectId,id),run=terminalDispatch(this.store,r);
  if(!run)fail('EXECUTION_UNCONFIRMED');
  r.runId=run.id;r.recoveryRequired=false;r.issue=null;r.status=run.execution==='completed'?'execution_completed':run.execution==='failed'?'failed':'interrupted';this.save(r);return this.record(projectId,id);
 }
 qualityPreview(projectId:string,id:string,reviewers:QualitySelection[],limits:QualityLoopInput['limits']){
  if(containsCredential(JSON.stringify({reviewers,limits})))throw new AppError('SENSITIVE_EXECUTION_INPUT',400);
  const r=this.record(projectId,id);if(!r.runId||r.recoveryRequired||!['execution_completed','quality_blocked','quality_failed'].includes(r.status)||r.quality?.recoveryRequired)fail('QUALITY_SOURCE_INVALID');
  return this.controller.qualityLoops.preview(projectId,r.runId!,reviewers,limits);
 }
 async resumeQuality(projectId:string,id:string){
  const r=this.record(projectId,id);if(!r.qualityLoopId||!r.quality?.recoveryRequired)fail('QUALITY_RECOVERY_NOT_REQUIRED');
  await this.controller.qualityLoops.resume(r.qualityLoopId);return this.record(projectId,id);
 }
 startQuality(projectId:string,id:string,input:Omit<QualityLoopStart,'projectId'|'sourceRunId'>){
  if(containsCredential(JSON.stringify(input)))throw new AppError('SENSITIVE_EXECUTION_INPUT',400);
  const r=this.record(projectId,id);if(!r.runId||r.recoveryRequired)fail('QUALITY_SOURCE_INVALID');
  const loop=this.controller.qualityLoops.start({...input,projectId,sourceRunId:r.runId!});
  const saved=this.raw(projectId,id);saved.qualityLoopId=loop.id;this.save(saved);return this.record(projectId,id);
 }
}

export function readCapabilityExecution(store:Store,projectId:string,id:string):CapabilityExecutionRecord {
  const row=store.db.prepare('SELECT body FROM capability_executions WHERE id=? AND project_id=?').get(id,projectId);
  if(!row)throw new AppError('CAPABILITY_EXECUTION_NOT_FOUND',404);
  const r=JSON.parse(String(row.body)) as CapabilityExecutionRecord,run=r.runId?store.getRun(r.runId):store.findRequest(r.dispatchRequestId)?.run;
  if(run){
   r.runId=run.id;
   const evidence=qualityRunEvidence(store,run),codex=evidence.codex;
   const configRow=store.db.prepare("SELECT data FROM events WHERE run_id=? AND kind='run.model_configuration' ORDER BY seq DESC LIMIT 1").get(run.id);
   const config=configRow?JSON.parse(String(configRow.data)):null;
   r.models={selectedModelId:codex?.selectedModelId??null,requestedModelId:codex?.requestedModelId??null,serverModelId:codex?.serverModelId??config?.serverModelId??null,actualModelId:evidence.source==='native_observed'?evidence.modelId!:'unknown',source:evidence.source};
   if(run.execution==='completed')r.status='execution_completed';
   else if(run.execution==='interrupted')r.status='interrupted';
   else if(run.execution==='failed')r.status='failed';
   else if(run.execution==='lost'){r.status='recovery_required';r.issue='EXECUTION_UNCONFIRMED';r.recoveryRequired=true;}
   else if(!r.recoveryRequired)r.status=run.execution==='interrupting'?'interrupt_requested':'running';
   if(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quality_loops'").get()){
    const loops=store.db.prepare('SELECT body FROM quality_loops WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(row=>JSON.parse(String(row.body)) as QualityLoopRecord);
    r.quality=loops.find(loop=>loop.sourceRunId===run.id)??null;
    if(r.quality){r.qualityLoopId=r.quality.id;r.status=r.quality.result.status==='passed'?'quality_passed':r.quality.result.status==='blocked'?'quality_blocked':['reviewing','repairing'].includes(r.quality.result.status)?'quality_running':'quality_failed';}
   }
  }
  r.providerEvidence=providerExecutionEvidence(store,run,r.quality);
  return r;
 }
