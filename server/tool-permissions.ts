import {toolGrantable} from './tool-capability-ledger.ts';
import {createHash,randomUUID} from 'node:crypto';
import type {ToolGrant,ToolKey,ToolKind} from '../shared/tool-capabilities.ts';
import type {RuntimeId} from '../shared/capability-orchestration.ts';
import {Store} from './store.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {readDataRecord} from './guardrails/outbound.ts';

export type ToolGrantState='active'|'used'|'revoked';
export interface ToolPermissionGrant {grantId:string;requestId:string;projectId:string;taskId:string;key:ToolKey;itemDigest:string;state:ToolGrantState;createdAt:string;updatedAt:string}
export interface ToolGrantBinding {projectId:string;taskId:string;key:ToolKey;itemDigest:string}

function invalid():never {throw new AppError('INVALID_FIELDS',400);}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
// Discovery ids and item digests are sha256 hex (server/extensions.ts, tool-capability-ledger itemDigest); nothing else is accepted.
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value:unknown,keys:string[])=>readDataRecord(value,keys)??invalid();
// Single source of the TOOLS-D1 grant rule (only Codex MCP).
const grantable=toolGrantable;

/** Exact fields, no getters; secret-like strings are rejected before format checks so the error never echoes them. */
function binding(value:unknown,extra:string[]):Record<string,unknown>&ToolGrantBinding {
  const data=exact(value,['projectId','taskId','key','itemDigest',...extra]);
  const key=exact(data.key,['runtimeId','kind','itemId']);
  for(const field of [...Object.values(data),...Object.values(key)])if(typeof field==='string'&&containsCredential(field))throw new AppError('TOOL_PERMISSION_CREDENTIAL_INPUT',400);
  if(!id(data.projectId)||!id(data.taskId)||!sha(data.itemDigest)||!sha(key.itemId)||!['codex','claude-code'].includes(key.runtimeId as string)
    ||!['mcp','skill','plugin','hook','subagent','slash_command'].includes(key.kind as string))invalid();
  return {...data,key:{runtimeId:key.runtimeId as RuntimeId,kind:key.kind as ToolKind,itemId:key.itemId}} as Record<string,unknown>&ToolGrantBinding;
}
const same=(a:ToolGrantBinding,b:ToolGrantBinding)=>a.projectId===b.projectId&&a.taskId===b.taskId&&a.key.runtimeId===b.key.runtimeId&&a.key.kind===b.key.kind&&a.key.itemId===b.key.itemId;

/** Durable Orbit allowlist. A grant is task-scoped, one-time, and void when the item's metadata digest changes. */
export class ToolPermissionStore {
  private store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS tool_grants (
      grant_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,
      project_id TEXT NOT NULL,task_id TEXT NOT NULL,runtime_id TEXT NOT NULL,kind TEXT NOT NULL,item_id TEXT NOT NULL,item_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','used','revoked')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    )`);
  }
  private row(grantId:string):ToolPermissionGrant|null {
    const r=this.store.db.prepare('SELECT * FROM tool_grants WHERE grant_id=?').get(grantId);
    return r?{grantId:String(r.grant_id),requestId:String(r.request_id),projectId:String(r.project_id),taskId:String(r.task_id),
      key:{runtimeId:String(r.runtime_id) as RuntimeId,kind:String(r.kind) as ToolKind,itemId:String(r.item_id)},itemDigest:String(r.item_digest),
      state:String(r.state) as ToolGrantState,createdAt:String(r.created_at),updatedAt:String(r.updated_at)}:null;
  }
  private get(grantId:unknown):ToolPermissionGrant {
    if(!id(grantId))invalid();
    return this.row(grantId)??(()=>{throw new AppError('TOOL_GRANT_NOT_FOUND',404);})();
  }
  private audit(kind:string,g:ToolPermissionGrant,code:string){this.store.append('tool.grant.'+kind,null,{grantId:g.grantId,projectId:g.projectId,taskId:g.taskId,code});}

  grant(input:unknown):ToolPermissionGrant {
    const data=binding(input,['requestId','confirmed']);
    const requestId=data.requestId;if(!id(requestId))invalid();
    if(data.confirmed!==true)throw new AppError('TOOL_GRANT_CONFIRMATION_REQUIRED',400);
    if(!grantable(data.key.runtimeId,data.key.kind))throw new AppError('TOOL_NOT_GRANTABLE',403);
    const digest=createHash('sha256').update(JSON.stringify([data.projectId,data.taskId,data.key.runtimeId,data.key.kind,data.key.itemId,data.itemDigest])).digest('hex');
    return this.store.transaction(()=>{
      const prior=this.store.db.prepare('SELECT grant_id,request_digest FROM tool_grants WHERE request_id=?').get(requestId);
      if(prior){if(prior.request_digest!==digest)throw new AppError('TOOL_GRANT_REQUEST_CONFLICT',409);return this.row(String(prior.grant_id))!;}
      const now=new Date().toISOString(),grantId='tg_'+randomUUID();
      this.store.db.prepare('INSERT INTO tool_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(grantId,requestId,digest,data.projectId,data.taskId,data.key.runtimeId,data.key.kind,data.key.itemId,data.itemDigest,'active',now,now);
      const g=this.row(grantId)!;this.audit('created',g,'TOOL_GRANT_CREATED');return g;
    });
  }

  /** Active grant for this exact task binding and current metadata digest, else null. */
  validFor(key:ToolKey,currentItemDigest:string,projectId:string,taskId:string):ToolGrant|null {
    const want=binding({projectId,taskId,key,itemDigest:currentItemDigest},[]);
    if(!grantable(want.key.runtimeId,want.key.kind))return null;
    const r=this.store.db.prepare("SELECT grant_id FROM tool_grants WHERE state='active' AND project_id=? AND task_id=? AND runtime_id=? AND kind=? AND item_id=? AND item_digest=? ORDER BY rowid LIMIT 1")
      .get(want.projectId,want.taskId,want.key.runtimeId,want.key.kind,want.key.itemId,want.itemDigest);
    if(!r)return null;
    const g=this.row(String(r.grant_id))!;return {grantId:g.grantId,key:g.key,itemDigest:g.itemDigest};
  }

  /** One-time: the conditional UPDATE marks it used atomically; a second consume fails. */
  consume(grantId:string,input:unknown):ToolPermissionGrant {
    const want=binding(input,[]);
    return this.store.transaction(()=>this.consumeInTransaction(grantId,want));
  }

  /** Same as consume() for callers already inside Store.transaction (Store forbids nesting); refuses outside one. */
  consumeInTransaction(grantId:string,input:unknown):ToolPermissionGrant {
    if(!this.store.db.isTransaction)throw new Error('TRANSACTION_REQUIRED');
    const want=binding(input,[]);
    const g=this.get(grantId);
    if(g.state!=='active')throw new AppError('TOOL_GRANT_NOT_ACTIVE',409);
    if(!same(g,want))throw new AppError('TOOL_GRANT_BINDING_MISMATCH',409);
    if(g.itemDigest!==want.itemDigest)throw new AppError('TOOL_GRANT_METADATA_CHANGED',409);
    const now=new Date().toISOString();
    // Binding is repeated in the WHERE so the transition itself is exact, not only the prior read.
    if(this.store.db.prepare(`UPDATE tool_grants SET state='used',updated_at=? WHERE grant_id=? AND state='active'
      AND project_id=? AND task_id=? AND runtime_id=? AND kind=? AND item_id=? AND item_digest=?`)
      .run(now,g.grantId,want.projectId,want.taskId,want.key.runtimeId,want.key.kind,want.key.itemId,want.itemDigest).changes!==1)throw new AppError('TOOL_GRANT_NOT_ACTIVE',409);
    const used=this.row(g.grantId)!;this.audit('used',used,'TOOL_GRANT_USED');return used;
  }

  /** Idempotent. A used grant stays used; neither used nor revoked grants ever count. */
  revoke(grantId:string):ToolPermissionGrant {
    return this.store.transaction(()=>{
      const g=this.get(grantId);if(g.state!=='active')return g;
      this.store.db.prepare("UPDATE tool_grants SET state='revoked',updated_at=? WHERE grant_id=? AND state='active'").run(new Date().toISOString(),g.grantId);
      const revoked=this.row(g.grantId)!;this.audit('revoked',revoked,'TOOL_GRANT_REVOKED');return revoked;
    });
  }
}
