/** Event-shape assumption: controller.ts and codex-planning.test.ts establish item/completed with threadId/turnId/item; tool-evidence.test.ts supplies a synthetic journal projection with item {id,type:'mcpToolCall',status:'completed',server,tool} and data.binding. T7 tests the controller projection with fake notifications; this is NOT live Codex integration proof. T8 must confirm the wire contract; other shapes remain unknown. */
import type {Store} from './store.ts';
import type {CompletionToolInvocation} from '../shared/task-completion.ts';
import type {ToolInvocation} from '../shared/tool-invocation.ts';
import {toolGrantable} from './tool-capability-ledger.ts';
import {createHash} from 'node:crypto';
import type {AppEvent,Run} from '../shared/types.ts';
import type {ToolGrant,ToolInvocationRecord} from '../shared/tool-capabilities.ts';

/** Trusted approval snapshot supplied by the caller, not extracted from the call event. */
export interface ToolGrantBinding extends ToolGrant {
  projectId:string;taskId:string;runId:string;threadId:string;invocationId?:string;
  approvedDigest:string;serverName:string;toolName:string;
}

const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
const bindingFields=['projectId','taskId','runId','threadId','grantId','itemDigest','approvedDigest','serverName','toolName'] as const;
const knownOtherItems=new Set(['agentMessage','reasoning','commandExecution','fileChange','webSearch','imageGeneration','collabAgentToolCall','enteredReviewMode','exitedReviewMode']);

/** Pure journal reader. Missing calls return []; unknown candidate calls are never native evidence. */
export function readToolInvocations(events:readonly AppEvent[],run:Run,grantBinding:ToolGrantBinding):ToolInvocationRecord[] {
  const rows=events.filter(event=>event.runId===run.id);
  const latest=(kind:string)=>rows.filter(event=>event.kind===kind).reduce<AppEvent|undefined>((last,event)=>!last||event.seq>last.seq?event:last,undefined)?.data;
  // Match provider-evidence.ts's Codex origin/outcome and observed-turn rules without opening a Store.
  const origin=latest('run.runtime_source'),outcome=latest('run.runtime_outcome');
  const mock=origin?.source==='mock'||outcome?.source==='mock';
  const native=!mock&&(!outcome||outcome.source==='native')&&origin?.source==='native'&&origin.interface==='codex.app_server'&&nonempty(run.turnId);
  const b=grantBinding;
  const grantMatches=toolGrantable(b.key.runtimeId,b.key.kind)&&run.runtime==='codex'
    &&bindingFields.every(field=>nonempty(b[field]))
    &&b.projectId===run.projectId&&b.taskId===run.taskId&&b.runId===run.id
    &&b.key.itemId===createHash('sha256').update(JSON.stringify(['mcp',b.serverName])).digest('hex');
  const records=new Map<string,ToolInvocationRecord>();
  for(const event of rows){
    if(event.kind!=='item/completed'&&!event.kind.startsWith('item/mcpToolCall/'))continue;
    const data=event.data,item=object(data.item),bound=object(data.binding),key=object(bound.key);
    if(event.kind==='item/completed'&&typeof item.type==='string'&&knownOtherItems.has(item.type))continue;
    const matches=grantMatches&&(!b.invocationId||bound.invocationId===b.invocationId)&&bindingFields.every(field=>bound[field]===b[field])
      &&key.runtimeId===b.key.runtimeId&&key.kind===b.key.kind&&key.itemId===b.key.itemId;
    const complete=event.kind==='item/completed'&&item.type==='mcpToolCall'&&item.status==='completed'
      &&nonempty(item.id)&&data.threadId===b.threadId&&data.turnId===run.turnId
      &&item.server===b.serverName&&item.tool===b.toolName;
    const evidenceSource=mock?'mock':native&&matches&&complete?'native':'unknown';
    const identity=nonempty(item.id)?JSON.stringify([data.threadId??null,data.turnId??null,item.id]):JSON.stringify(['seq',event.seq]);
    const previous=records.get(identity);
    if(previous){
      // Conflicting copies fail closed regardless of input order.
      if(previous.evidenceSource!==evidenceSource)previous.evidenceSource='unknown';
      if(!matches){previous.grantId=null;previous.itemDigest=null;if(b.invocationId)previous.bindingDigest=undefined;}
      if(b.invocationId&&(!matches||!complete)){previous.callCompleted=false;previous.bindingDigest=undefined;}
      continue;
    }
    records.set(identity,{key:{...b.key},evidenceSource,grantId:matches?b.grantId:null,itemDigest:matches?b.itemDigest:null,...(b.invocationId?{invocationId:b.invocationId,approvedDigest:b.approvedDigest,bindingDigest:matches?b.approvedDigest:undefined,nativeObserved:native,callCompleted:complete&&matches}:{})});
  }
  return [...records.values()];
}

/** Read-only join of the intent, atomic consumption receipt and Run journal. No GET repair or migration. */
export function readRecordedToolInvocations(store:Store,run:Run):CompletionToolInvocation[]{
  if(!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_grant_consumptions'").get())return [];
  const events=store.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY seq').all(run.id).map(r=>({seq:Number(r.seq),at:String(r.at),kind:String(r.kind),runId:run.id,data:JSON.parse(String(r.data))}));
  const launches=events.filter(e=>e.kind==='tool.launch.binding');
  const launch=launches.length===1?launches[0].data:null;
  const row=store.db.prepare('SELECT body FROM tool_invocations WHERE id=?').get(run.requestId);
  if(!row)return [];
  const invocation=JSON.parse(String(row.body)) as ToolInvocation;
  const fields=['projectId','taskId','itemDigest','grantId','planningContentHash','runtimeId','kind','itemId','invocationId','digest'] as const;
  if(invocation.invocationId!==run.requestId||launch&&fields.some(k=>launch[k]!==invocation[k])||invocation.projectId!==run.projectId||invocation.taskId!==run.taskId||invocation.planningContentHash!==run.planningContentHash)return [];
  const expected=createHash('sha256').update(JSON.stringify([invocation.projectId,invocation.taskId,invocation.runtimeId,invocation.kind,invocation.itemId,invocation.itemDigest,invocation.grantId,invocation.planningContentHash])).digest('hex');
  if(invocation.digest!==expected)return [];
  const g=store.db.prepare('SELECT g.*,c.invocation_id,c.approval_digest FROM tool_grants g LEFT JOIN tool_grant_consumptions c ON c.grant_id=g.grant_id WHERE g.grant_id=?').get(invocation.grantId);
  const key={runtimeId:invocation.runtimeId,kind:invocation.kind,itemId:invocation.itemId};
  const grant:ToolGrant|null=g&&g.project_id===run.projectId&&g.task_id===run.taskId&&g.runtime_id===key.runtimeId&&g.kind===key.kind&&g.item_id===key.itemId&&g.item_digest===invocation.itemDigest
    ?{grantId:invocation.grantId,key,itemDigest:String(g.item_digest),state:g.state as ToolGrant['state'],consumedBy:{invocationId:String(g.invocation_id),approvalDigest:String(g.approval_digest)}}:null;
  const calls=launch?events.filter(e=>e.kind==='item/completed'&&e.data.item?.type==='mcpToolCall'):[];
  const groups=new Map<string,typeof events>();
  for(const event of calls){
    const item=event.data.item,identity=nonempty(item.id)?JSON.stringify([event.data.threadId,event.data.turnId,item.id]):JSON.stringify(['seq',event.seq]);
    const group=groups.get(identity)??[];group.push(event);groups.set(identity,group);
  }
  const result:CompletionToolInvocation[]=[];
  const append=(record:ToolInvocationRecord)=>{
    const evidenceSource=invocation.evidenceSource==='mock'?'mock':invocation.status!=='completed'||invocation.evidenceSource!=='native'?'unknown':record.evidenceSource;
    result.push({...record,evidenceSource,id:invocation.invocationId,projectId:invocation.projectId,taskId:invocation.taskId,runId:run.id,planningContentHash:invocation.planningContentHash,grant});
  };
  for(const group of groups.values()){
    // Approval covers the MCP server; toolName identifies the observed call within this event group, not a tool-level permission.
    const toolName=group.map(e=>e.data.item.tool).filter(nonempty).sort()[0]??'';
    const binding:ToolGrantBinding={grantId:invocation.grantId,key,itemDigest:invocation.itemDigest,invocationId:invocation.invocationId,
      projectId:invocation.projectId,taskId:invocation.taskId,runId:run.id,threadId:launch!.threadId,approvedDigest:invocation.digest,serverName:launch!.serverName,toolName};
    for(const record of readToolInvocations([...events.filter(e=>e.kind!=='item/completed'),...group],run,binding))append(record);
  }
  if(!result.length)append({key,evidenceSource:'unknown',grantId:invocation.grantId,itemDigest:invocation.itemDigest,invocationId:invocation.invocationId,
    approvedDigest:invocation.digest,nativeObserved:false,callCompleted:false});
  return result;
}
