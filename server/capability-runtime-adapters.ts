import type {WorkerDispatchContext} from './worker-scheduler.ts';
import type {Controller} from './controller.ts';
import {terminal,type Run} from '../shared/types.ts';
import type {RuntimeOperationObservation} from '../shared/runtime-operation.ts';
import type {QualityLoopRecord} from '../shared/quality-loop-record.ts';
import {providerExecutionEvidence} from './provider-evidence.ts';
import type {RuntimeId,OrchestrationCapabilityId} from '../shared/capability-orchestration.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';

export interface RuntimeAdapterDefinition {
 readonly runtimeId:RuntimeId;
 readonly adapterId:string;
 readonly compatible:(version:string)=>boolean;
 readonly capabilities?:readonly OrchestrationCapabilityId[];
 /** Trusted implementation must retain Controller-owned execution, policy and journals. */
 readonly dispatch?:Controller['submitTask'];
}
export interface RuntimeAdapterSnapshot {
 runtimeId:RuntimeId;adapterId:string|null;revision:number;version:string|null;compatible:boolean;issue:string|null;
 capabilities:OrchestrationCapabilityId[];
}
const capabilities:readonly OrchestrationCapabilityId[]=['execute.code','execute.general','plan','review.text','model.actual','skills','slash_commands','hooks','mcp','resume','interrupt','status','result','subagents'];
const runtime=(id:unknown):id is RuntimeId=>id==='codex'||id==='claude-code';
const stableVersion=(version:unknown):version is string=>typeof version==='string'&&/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(version);
export function compatibleRuntimeVersion(runtimeId:RuntimeId,version:string):boolean {
 if(!stableVersion(version))return false;
 if(runtimeId==='codex')return version==='0.162.1'||version==='0.165.0';
 const [major,minor,patch]=version.split('.').map(Number);
 return major===2&&(minor>1||minor===1&&patch>=259);
}

/** Only trusted server code registers adapters. No executable paths, prompts, or plugin loading. */
export class CapabilityRuntimeAdapters {
 private controller:Pick<Controller,'submitTask'|'interrupt'|'store'>;
 private entries=new Map<RuntimeId,{definition:RuntimeAdapterDefinition&{capabilities:readonly OrchestrationCapabilityId[];dispatch:Controller['submitTask']};enabled:boolean}>();
 private revisions=new Map<RuntimeId,number>();
 private observedVersions=new Map<RuntimeId,string|null>();
 constructor(controller:Pick<Controller,'submitTask'|'interrupt'|'store'>){
  this.controller=controller;
  for(const runtimeId of ['codex','claude-code'] as const)this.register({runtimeId,adapterId:`orbit.${runtimeId}.task.v1`,compatible:version=>compatibleRuntimeVersion(runtimeId,version),capabilities:[runtimeId==='codex'?'execute.code':'execute.general','status','result','interrupt']},{trusted:true});
 }
 private bump(runtimeId:RuntimeId){this.revisions.set(runtimeId,(this.revisions.get(runtimeId)??0)+1);}
 register(definition:RuntimeAdapterDefinition,authorization:{trusted:boolean}):void {
  if(authorization?.trusted!==true)throw new AppError('ADAPTER_TRUST_REQUIRED',403);
  if(!definition||!runtime(definition.runtimeId)||typeof definition.adapterId!=='string'||!/^[-a-zA-Z0-9_.]{1,80}$/.test(definition.adapterId)||containsCredential(definition.adapterId)||typeof definition.compatible!=='function'||definition.dispatch!==undefined&&typeof definition.dispatch!=='function'||definition.capabilities!==undefined&&(!Array.isArray(definition.capabilities)||definition.capabilities.some(id=>!capabilities.includes(id))))throw new AppError('INVALID_ADAPTER',400);
  const supported=Object.freeze([...new Set(definition.capabilities??[definition.runtimeId==='codex'?'execute.code':'execute.general'])]);
  this.entries.set(definition.runtimeId,{definition:Object.freeze({...definition,capabilities:supported,dispatch:definition.dispatch??((...args:Parameters<Controller['submitTask']>)=>this.controller.submitTask(...args))}),enabled:true});
  this.observedVersions.delete(definition.runtimeId);this.bump(definition.runtimeId);
 }
 disable(runtimeId:RuntimeId):void {
  if(!runtime(runtimeId))throw new AppError('INVALID_ADAPTER',400);
  const entry=this.entries.get(runtimeId);if(entry?.enabled){entry.enabled=false;this.bump(runtimeId);}
 }
 unregister(runtimeId:RuntimeId):void {
  if(!runtime(runtimeId))throw new AppError('INVALID_ADAPTER',400);
  if(this.entries.delete(runtimeId)){this.observedVersions.delete(runtimeId);this.bump(runtimeId);}
 }
 snapshot(runtimeId:RuntimeId,version:string|null):RuntimeAdapterSnapshot {
  if(!runtime(runtimeId))throw new AppError('INVALID_ADAPTER',400);
  const safeVersion=stableVersion(version)?version:null,entry=this.entries.get(runtimeId);
  // Cache only sanitized discovery; the snapshot tuple, not a GET, invalidates plan versions.
  this.observedVersions.set(runtimeId,safeVersion);
  let compatible=false;
  try{compatible=!!entry?.enabled&&safeVersion!==null&&entry.definition.compatible(safeVersion)===true;}catch{/* A broken trusted contract fails closed. */}
  const issue=!entry?'ADAPTER_NOT_REGISTERED':!entry.enabled?'ADAPTER_DISABLED':!safeVersion?'RUNTIME_VERSION_UNKNOWN':!compatible?'RUNTIME_VERSION_UNSUPPORTED':null;
  return {runtimeId,adapterId:entry?.definition.adapterId??null,revision:this.revisions.get(runtimeId)??0,version:safeVersion,compatible,issue,capabilities:[...(entry?.definition.capabilities??[])]};
 }
 async dispatch(runtimeId:RuntimeId,projectId:string,taskId:string,input:{requestId:string;workspaceId?:string;expectedAcceptanceDigest?:string},worker?:WorkerDispatchContext):Promise<Run>{
  const contract=this.snapshot(runtimeId,this.observedVersions.get(runtimeId)??null);
  if(!contract.compatible)throw new AppError('CAPABILITY_RUNTIME_INCOMPATIBLE',409);
  if(!contract.capabilities.includes(runtimeId==='codex'?'execute.code':'execute.general'))throw new AppError('CAPABILITY_NOT_IMPLEMENTED',409);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['requestId','workspaceId','expectedAcceptanceDigest'].includes(key)))throw new AppError('INVALID_FIELDS',400);
  if(runtimeId==='codex'&&(typeof input.workspaceId!=='string'||!input.workspaceId)||runtimeId==='claude-code'&&Object.hasOwn(input,'workspaceId'))throw new AppError('RUNTIME_WORKSPACE_MISMATCH',409);
  worker?.beforeDispatch();
  // Controller rechecks stored runtime selection and owns idempotency, policy and native execution.
  const dispatch=this.entries.get(runtimeId)!.definition.dispatch;
  return worker?dispatch(projectId,taskId,input,worker):dispatch(projectId,taskId,input);
 }
 private ownedRun(runtimeId:RuntimeId,runId:string,projectId?:string):Run {
  if(!runtime(runtimeId))throw new AppError('INVALID_ADAPTER',400);
  const run=this.controller.store.getRun(runId);
  if(!run)throw new AppError('RUN_NOT_FOUND',404);
  if((run.runtime??'codex')!==runtimeId)throw new AppError('RUNTIME_MISMATCH',409);
  const owner=run.projectId??this.controller.store.workspaces().find(workspace=>workspace.id===run.workspaceId)?.projectId;
  if(!owner||projectId!==undefined&&owner!==projectId)throw new AppError('PROJECT_MISMATCH',409);
  return run;
 }
 observe(runtimeId:RuntimeId,projectId:string,runId:string):RuntimeOperationObservation {
  if(typeof projectId!=='string'||!projectId)throw new AppError('PROJECT_MISMATCH',409);
  const run=this.ownedRun(runtimeId,runId,projectId),store=this.controller.store;
  let quality:QualityLoopRecord|null=null;
  if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quality_loops'").get()){
   const records=store.db.prepare('SELECT body FROM quality_loops WHERE project_id=? ORDER BY rowid DESC').all(projectId);
   quality=records.map(row=>JSON.parse(String(row.body)) as QualityLoopRecord).find(record=>record.sourceRunId===run.id)??null;
  }
  return {runtimeId,projectId,runId:run.id,taskId:run.taskId??null,execution:run.execution,terminal:terminal(run.execution),stopConfirmed:['completed','failed','interrupted'].includes(run.execution),response:run.execution==='completed'?run.response:null,providerEvidence:providerExecutionEvidence(store,run,quality)};
 }
 async interrupt(runtimeId:RuntimeId,runId:string,projectId?:string):Promise<void>{
  this.ownedRun(runtimeId,runId,projectId);
  // Contract changes must never remove the ability to stop an already running task.
  await this.controller.interrupt(runId);
 }
}
