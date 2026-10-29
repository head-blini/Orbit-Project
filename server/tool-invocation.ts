import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import type {ToolPermissionStore} from './tool-permissions.ts';
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
  constructor(store:Store,ports:ToolInvocationPorts){
    this.store=store;this.ports=ports;
    store.db.exec(`CREATE TABLE IF NOT EXISTS tool_invocation_previews(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_invocations(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,body TEXT NOT NULL)`);
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
    return {...s,itemDigest:currentItemDigest,grantId:grant.grantId,planningContentHash};
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
      if(digest(current)!==expectedDigest)throw new AppError('ROUTE_CHANGED',409);
      const now=new Date().toISOString();
      const record:ToolInvocation={...current,invocationId:randomUUID(),requestId,previewId,digest:expectedDigest,createdAt:now,updatedAt:now,status:'unknown',evidenceSource:'unknown',issue:'OPERATION_UNCONFIRMED'};
      // T2 consume() opens a transaction; Store forbids nesting. Keep its conditional transition and audit in this transaction.
      const used=this.store.db.prepare(`UPDATE tool_grants SET state='used',updated_at=? WHERE grant_id=? AND state='active'
        AND project_id=? AND task_id=? AND runtime_id=? AND kind=? AND item_id=? AND item_digest=?`)
        .run(now,current.grantId,current.projectId,current.taskId,current.runtimeId,current.kind,current.itemId,current.itemDigest);
      if(used.changes!==1)throw new AppError('ROUTE_CHANGED',409);
      this.store.append('tool.grant.used',null,{grantId:current.grantId,projectId:current.projectId,taskId:current.taskId,code:'TOOL_GRANT_USED'});
      this.store.db.prepare('INSERT INTO tool_invocations VALUES(?,?,?,?)').run(record.invocationId,requestId,inputDigest,JSON.stringify(record));
      this.audit(record);
      return {record,replay:false};
    });
    if(prepared.replay)return prepared.record;
    const record=prepared.record;
    const launch:ToolLaunchRequest={...keyOf(record),projectId:record.projectId,taskId:record.taskId,itemDigest:record.itemDigest,grantId:record.grantId,planningContentHash:record.planningContentHash,invocationId:record.invocationId,requestId,previewId,digest:record.digest};
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
