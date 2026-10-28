import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import type {CapabilityRuntimeAdapters} from './capability-runtime-adapters.ts';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';
import type {CapabilityInvocationInput,CapabilityInvocationRecord} from '../shared/capability-invocation.ts';
import {AppError} from './errors.ts';
import {exact} from './studio.ts';
import {containsCredential} from './privacy.ts';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Run-scoped operations only. No prompt, CLI argument, installation or new dispatch port. */
export class CapabilityInvocationService {
 private store:Store;private adapters:CapabilityRuntimeAdapters;
 constructor(store:Store,adapters:CapabilityRuntimeAdapters){
  this.store=store;this.adapters=adapters;
  store.db.exec('CREATE TABLE IF NOT EXISTS capability_invocations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,body TEXT NOT NULL)');
 }
 records(projectId:string):CapabilityInvocationRecord[]{
  if(!this.store.projects().some(p=>p.id===projectId))throw new AppError('PROJECT_NOT_FOUND',404);
  return this.store.db.prepare('SELECT body FROM capability_invocations WHERE project_id=? ORDER BY rowid DESC LIMIT 200').all(projectId).map(row=>JSON.parse(String(row.body)));
 }
 private save(r:CapabilityInvocationRecord){r.updatedAt=new Date().toISOString();this.store.transaction(()=>{this.store.db.prepare('UPDATE capability_invocations SET body=? WHERE id=?').run(JSON.stringify(r),r.id);this.store.append('capability.invocation',r.runId,{projectId:r.projectId,taskId:r.taskId,invocationId:r.id,capabilityId:r.capabilityId,status:r.status,issue:r.issue});});}
 async invoke(projectId:string,input:CapabilityInvocationInput):Promise<CapabilityInvocationRecord>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('INVALID_FIELDS',400);
  exact(input as unknown as Record<string,unknown>,['requestId','routeId','expectedDigest','confirmed']);
  if(typeof input.requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.requestId)||containsCredential(input.requestId)||typeof input.routeId!=='string'||!/^[a-f0-9-]{36}$/.test(input.routeId)||typeof input.expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedDigest))throw new AppError('INVALID_FIELDS',400);
  if(input.confirmed!==true)throw new AppError('APPROVAL_REQUIRED',409);
  this.records(projectId);const digest=hash({projectId,...input});
  const prior=this.store.db.prepare('SELECT input_digest,body FROM capability_invocations WHERE request_id=?').get(input.requestId);
  if(prior){if(prior.input_digest!==digest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return JSON.parse(String(prior.body));}
  const row=this.store.db.prepare('SELECT body FROM capability_routes WHERE id=? AND project_id=?').get(input.routeId,projectId);
  if(!row)throw new AppError('ROUTE_NOT_FOUND',404);const route=JSON.parse(String(row.body)) as CapabilityRouteDecision;
  if(route.status!=='recommended'||!route.runId||!route.runtimeId||!['status','result','interrupt'].includes(route.intent)||route.capabilityId!==route.intent)throw new AppError('ROUTE_NOT_EXECUTABLE',409);
  if(route.invocationDigest!==input.expectedDigest)throw new AppError('ROUTE_CHANGED',409);
  const before=this.adapters.observe(route.runtimeId,projectId,route.runId),run=this.store.getRun(route.runId)!;
  if(before.taskId!==route.taskId||run.planningVersionId!==route.baseline.planningVersionId||run.planningContentHash!==route.baseline.planningContentHash)throw new AppError('ROUTE_CHANGED',409);
  const record:CapabilityInvocationRecord={id:randomUUID(),requestId:input.requestId,projectId,taskId:route.taskId,routeId:route.id,runId:route.runId,runtimeId:route.runtimeId,capabilityId:route.intent as 'status'|'result'|'interrupt',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'unknown',issue:'OPERATION_UNCONFIRMED',result:null};
  this.store.transaction(()=>{this.store.db.prepare('INSERT INTO capability_invocations VALUES(?,?,?,?,?)').run(record.id,projectId,input.requestId,digest,JSON.stringify(record));this.store.append('capability.invocation',record.runId,{projectId,taskId:record.taskId,invocationId:record.id,capabilityId:record.capabilityId,status:'unknown'});});
  try{
   // Persist intent before await. Duplicate or restarted requests observe it and never send another interrupt.
   if(record.capabilityId==='interrupt'&&!before.stopConfirmed)await this.adapters.interrupt(record.runtimeId,record.runId,projectId);
   const observation=this.adapters.observe(record.runtimeId,projectId,record.runId);
   record.result={...observation,response:record.capabilityId==='result'?observation.response:null};
   record.status=record.capabilityId==='interrupt'&&!observation.stopConfirmed?'requested':'completed';record.issue=null;
  }catch{record.status=record.capabilityId==='interrupt'?'unknown':'failed';record.issue=record.capabilityId==='interrupt'?'INTERRUPT_UNCONFIRMED':'OBSERVATION_FAILED';}
  this.save(record);return record;
 }
}
