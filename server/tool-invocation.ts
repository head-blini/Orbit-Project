import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import {ToolPermissionStore} from './tool-permissions.ts';
import type {ToolItemMeta} from '../shared/tool-capabilities.ts';
import type {ToolInvocation,ToolInvocationBinding,ToolInvocationPreview,ToolInvocationSelection,ToolLaunchPort,ToolLaunchRequest} from '../shared/tool-invocation.ts';
import {itemDigest,toolGrantable} from './tool-capability-ledger.ts';
import {readDataRecord} from './guardrails/outbound.ts';
import {containsCredential} from './privacy.ts';
import {AppError} from './errors.ts';

export interface ToolInvocationPorts {
  /** Synchronous current snapshots; null means unavailable. Never perform discovery RPCs here. */
  discovery(selection:Readonly<ToolInvocationSelection>):ToolItemMeta|null;
  planningContentHash(projectId:string,taskId:string):string|null;
  /** Must read the same Store's T2 grant table; consumption is part of the intent transaction. */
  grants:Pick<ToolPermissionStore,'validFor'>;
  launch:ToolLaunchPort;
  launchContext?:(selection:Readonly<ToolInvocationSelection>)=>string;
}
interface SavedPreview extends ToolInvocationPreview {binding:ToolInvocationBinding}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)&&!containsCredential(v);
const fields=(v:unknown,keys:string[])=>{const r=readDataRecord(v,keys);if(!r)throw new AppError('INVALID_FIELDS',400);return r;};
const digest=(b:ToolInvocationBinding)=>hash([b.projectId,b.taskId,b.runtimeId,b.kind,b.itemId,b.itemDigest,b.grantId,b.planningContentHash]);
const keyOf=(s:ToolInvocationSelection)=>({runtimeId:s.runtimeId,kind:s.kind,itemId:s.itemId});

export class ToolInvocationService {
  private store:Store;
  private ports:ToolInvocationPorts;
  /** Consumption always runs on this Store, whatever the lookup port is. */
  private grantStore:ToolPermissionStore;
  constructor(store:Store,ports:ToolInvocationPorts){
    this.store=store;this.ports=ports;this.grantStore=new ToolPermissionStore(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS tool_invocation_previews(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_invocations(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_approval_previews(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_grant_consumptions(grant_id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL UNIQUE,approval_digest TEXT NOT NULL)`);
  }
  /** First HTTP stage captures metadata and baseline without granting or launching. */
  previewApproval(input:unknown):ToolInvocationPreview {
    const data=fields(input,['projectId','taskId','runtimeId','kind','itemId']);
    if(!id(data.projectId)||!id(data.taskId)||!sha(data.itemId)||!['codex','claude-code'].includes(data.runtimeId as string)||!['mcp','skill','plugin','hook','subagent','slash_command'].includes(data.kind as string))throw new AppError('INVALID_FIELDS',400);
    const selection=data as unknown as ToolInvocationSelection;
    if(!toolGrantable(selection.runtimeId,selection.kind))throw new AppError('TOOL_NOT_GRANTABLE',403);
    const meta=this.ports.discovery(selection),planningContentHash=this.ports.planningContentHash(selection.projectId,selection.taskId);
    if(!meta||meta.id!==selection.itemId||meta.kind!==selection.kind)throw new AppError('TOOL_ITEM_NOT_FOUND',409);
    if(!sha(planningContentHash))throw new AppError('PLANNING_BASELINE_REQUIRED',409);
    const binding={...selection,itemDigest:itemDigest(meta),planningContentHash,...(this.ports.launchContext?{launchContext:this.ports.launchContext(selection)}:{})};
    const preview={previewId:randomUUID(),digest:hash(binding),binding};
    this.store.db.prepare('INSERT INTO tool_approval_previews VALUES(?,?)').run(preview.previewId,JSON.stringify(preview));
    return {previewId:preview.previewId,digest:preview.digest};
  }
  approve(input:unknown):ToolInvocationPreview {
    const data=fields(input,['requestId','previewId','expectedDigest','confirmed']);
    if(!id(data.requestId)||!id(data.previewId)||!sha(data.expectedDigest))throw new AppError('INVALID_FIELDS',400);
    if(data.confirmed!==true)throw new AppError('APPROVAL_REQUIRED',409);
    const row=this.store.db.prepare('SELECT body FROM tool_approval_previews WHERE id=?').get(data.previewId);
    if(!row)throw new AppError('ROUTE_NOT_FOUND',404);
    const saved=JSON.parse(String(row.body));
    if(saved.digest!==data.expectedDigest)throw new AppError('ROUTE_CHANGED',409);
    if(saved.approved){if(saved.requestId!==data.requestId)throw new AppError('IDEMPOTENCY_CONFLICT',409);return saved.approved;}
    const b=saved.binding as Omit<ToolInvocationBinding,'grantId'>;
    const selection={projectId:b.projectId,taskId:b.taskId,...keyOf(b)},meta=this.ports.discovery(selection);
    if(!meta||itemDigest(meta)!==b.itemDigest||this.ports.planningContentHash(b.projectId,b.taskId)!==b.planningContentHash||this.ports.launchContext?.(selection)!==b.launchContext)throw new AppError('ROUTE_CHANGED',409);
    // T2's idempotent transaction survives a crash between grant and preview persistence.
    if(!this.ports.grants.validFor(keyOf(b),b.itemDigest,b.projectId,b.taskId))this.grantStore.grant({requestId:data.requestId,projectId:b.projectId,taskId:b.taskId,key:keyOf(b),itemDigest:b.itemDigest,confirmed:true});
    const approved=this.preview(selection);
    this.store.db.prepare('UPDATE tool_approval_previews SET body=? WHERE id=?').run(JSON.stringify({...saved,requestId:data.requestId,approved}),data.previewId);
    return approved;
  }
  private current(s:ToolInvocationSelection,invoking=false):ToolInvocationBinding {
    const reject=(code:string):never=>{throw new AppError(invoking?'ROUTE_CHANGED':code,409);};
    if(!toolGrantable(s.runtimeId,s.kind))throw new AppError('TOOL_NOT_GRANTABLE',403);
    const meta=this.ports.discovery(Object.freeze({...s}));
    if(!meta||meta.id!==s.itemId||meta.kind!==s.kind)return reject('TOOL_ITEM_NOT_FOUND');
    const currentItemDigest=itemDigest(meta);
    const planningContentHash=this.ports.planningContentHash(s.projectId,s.taskId);
    if(!sha(planningContentHash))return reject('PLANNING_BASELINE_REQUIRED');
    const grant=this.ports.grants.validFor(keyOf(s),currentItemDigest,s.projectId,s.taskId);
    if(!grant||!id(grant.grantId)||grant.itemDigest!==currentItemDigest||grant.key.runtimeId!==s.runtimeId||grant.key.kind!==s.kind||grant.key.itemId!==s.itemId)return reject('TOOL_GRANT_REQUIRED');
    let launchContext:string|undefined;
    try{launchContext=this.ports.launchContext?.(s);}catch(error){if(invoking&&error instanceof AppError)return reject(error.message);throw error;}
    return {...s,itemDigest:currentItemDigest,grantId:grant.grantId,planningContentHash,...(launchContext!==undefined?{launchContext}:{})};
  }
  preview(input:unknown):ToolInvocationPreview {
    const data=fields(input,['projectId','taskId','runtimeId','kind','itemId']);
    if(!id(data.projectId)||!id(data.taskId)||!sha(data.itemId)||!['codex','claude-code'].includes(data.runtimeId as string)||!['mcp','skill','plugin','hook','subagent','slash_command'].includes(data.kind as string))throw new AppError('INVALID_FIELDS',400);
    const binding=this.current(data as unknown as ToolInvocationSelection);
    const preview:SavedPreview={previewId:randomUUID(),digest:digest(binding),binding};
    this.store.db.prepare('INSERT INTO tool_invocation_previews VALUES(?,?)').run(preview.previewId,JSON.stringify(preview));
    return {previewId:preview.previewId,digest:preview.digest};
  }
  async invoke(input:unknown):Promise<ToolInvocation> {
    const data=fields(input,['requestId','previewId','expectedDigest','confirmed']);
    if(!id(data.requestId)||!id(data.previewId)||!sha(data.expectedDigest))throw new AppError('INVALID_FIELDS',400);
    if(data.confirmed!==true)throw new AppError('APPROVAL_REQUIRED',409);
    const requestId=data.requestId,previewId=data.previewId,expectedDigest=data.expectedDigest;
    const inputDigest=hash([requestId,previewId,expectedDigest,true]);
    const prepared=this.store.transaction(()=>{
      const prior=this.store.db.prepare('SELECT input_digest,body FROM tool_invocations WHERE request_id=?').get(requestId);
      if(prior){if(prior.input_digest!==inputDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return {record:JSON.parse(String(prior.body)) as ToolInvocation,replay:true};}
      const row=this.store.db.prepare('SELECT body FROM tool_invocation_previews WHERE id=?').get(previewId);
      if(!row)throw new AppError('ROUTE_NOT_FOUND',404);
      const preview=JSON.parse(String(row.body)) as SavedPreview;
      if(preview.digest!==expectedDigest)throw new AppError('ROUTE_CHANGED',409);
      const b=preview.binding;
      const current=this.current({projectId:b.projectId,taskId:b.taskId,runtimeId:b.runtimeId,kind:b.kind,itemId:b.itemId},true);
      if(digest(current)!==expectedDigest||current.launchContext!==b.launchContext)throw new AppError('ROUTE_CHANGED',409);
      const now=new Date().toISOString();
      const record:ToolInvocation={...current,invocationId:randomUUID(),requestId,previewId,digest:expectedDigest,createdAt:now,updatedAt:now,status:'unknown',evidenceSource:'unknown',issue:'OPERATION_UNCONFIRMED'};
      // Shared T2 transition inside this intent transaction; any grant failure means the approved route no longer holds.
      try{this.grantStore.consumeInTransaction(current.grantId,{projectId:current.projectId,taskId:current.taskId,key:keyOf(current),itemDigest:current.itemDigest});}
      catch(error){if(error instanceof AppError)throw new AppError('ROUTE_CHANGED',409);throw error;}
      this.store.db.prepare('INSERT INTO tool_grant_consumptions VALUES(?,?,?)').run(current.grantId,record.invocationId,record.digest);
      this.store.db.prepare('INSERT INTO tool_invocations VALUES(?,?,?,?)').run(record.invocationId,requestId,inputDigest,JSON.stringify(record));
      this.audit(record);
      return {record,replay:false};
    });
    if(prepared.replay)return prepared.record;
    const record=prepared.record;
    const launch:ToolLaunchRequest={...keyOf(record),projectId:record.projectId,taskId:record.taskId,itemDigest:record.itemDigest,grantId:record.grantId,planningContentHash:record.planningContentHash,invocationId:record.invocationId,requestId,previewId,digest:record.digest,...(record.launchContext?{launchContext:record.launchContext}:{})};
    try{
      const result=readDataRecord(await this.ports.launch.invoke(Object.freeze(launch)),['status','evidenceSource']);
      if(result&&['completed','failed'].includes(result.status as string)&&['native','mock'].includes(result.evidenceSource as string)){
        record.status=result.status as 'completed'|'failed';record.evidenceSource=result.evidenceSource as 'native'|'mock';record.issue=null;
      }
    }catch{/* Submission may have happened. Preserve unknown; never persist raw provider errors or retry. */}
    record.updatedAt=new Date().toISOString();
    this.store.transaction(()=>{
      this.store.db.prepare('UPDATE tool_invocations SET body=? WHERE id=?').run(JSON.stringify(record),record.invocationId);
      this.audit(record);
    });
    return record;
  }
  private audit(record:ToolInvocation){
    this.store.append('tool.invocation',null,{invocationId:record.invocationId,projectId:record.projectId,taskId:record.taskId,status:record.status,issue:record.issue});
  }
}
