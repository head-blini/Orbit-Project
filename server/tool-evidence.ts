/** Event-shape assumption: controller.ts and codex-planning.test.ts establish item/completed with threadId/turnId/item; tool-evidence.test.ts supplies a synthetic journal projection with item {id,type:'mcpToolCall',status:'completed',server,tool} and data.binding. This is NOT a confirmed Codex wire contract: T7/T8 must validate the projection before wiring it; other shapes remain unknown. */
import {toolGrantable} from './tool-capability-ledger.ts';
import {createHash} from 'node:crypto';
import type {AppEvent,Run} from '../shared/types.ts';
import type {ToolGrant,ToolInvocationRecord} from '../shared/tool-capabilities.ts';

/** Trusted approval snapshot supplied by the caller, not extracted from the call event. */
export interface ToolGrantBinding extends ToolGrant {
  projectId:string;taskId:string;runId:string;threadId:string;
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
  const native=!mock&&origin?.source==='native'&&origin.interface==='codex.app_server'&&nonempty(run.turnId);
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
    const matches=grantMatches&&bindingFields.every(field=>bound[field]===b[field])
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
      if(!matches){previous.grantId=null;previous.itemDigest=null;}
      continue;
    }
    records.set(identity,{key:{...b.key},evidenceSource,grantId:matches?b.grantId:null,itemDigest:matches?b.itemDigest:null});
  }
  return [...records.values()];
}
