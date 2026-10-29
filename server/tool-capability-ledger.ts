import {createHash} from 'node:crypto';
import type {ToolAggregate,ToolDiscoverySection,ToolGrant,ToolInvocationRecord,ToolItemMeta,ToolKey,ToolKind,ToolState} from '../shared/tool-capabilities.ts';

/** Orbit never loads plugins; hooks/subagents are discovery-only (TOOLS-D1 defaults 3-4). */
// Adopted defaults (docs/ORBIT-TOOLS-D1.md): only Codex MCP is grantable; skills unsupported, slash/Claude MCP blocked, hooks/subagents discovery-only, plugins never loaded.
const GRANTABLE:ReadonlySet<ToolKind>=new Set(['mcp']);
export const toolGrantable=(runtimeId:unknown,kind:unknown)=>runtimeId==='codex'&&GRANTABLE.has(kind as ToolKind);
const keyId=(key:ToolKey)=>JSON.stringify([key.runtimeId,key.kind,key.itemId]);
const bySort=(a:string,b:string)=>a<b?-1:a>b?1:0;
export const itemDigest=(meta:ToolItemMeta):string=>createHash('sha256').update(JSON.stringify([meta.kind,meta.id,meta.scope??null,meta.handlerType??null,meta.nativeTrust??null,meta.pluginOwned??null,meta.runtimeVersion??null,meta.adapterRevision??null])).digest('hex');

/** Verification consumes journal proof, never a launch result or an active permission alone. */
export function toolInvocationVerified(record:ToolInvocationRecord,grant:ToolGrant|null|undefined):boolean {
  return !!grant&&toolGrantable(record.key.runtimeId,record.key.kind)&&keyId(grant.key)===keyId(record.key)
    &&grant.grantId===record.grantId&&grant.itemDigest===record.itemDigest
    &&record.evidenceSource==='native'&&record.nativeObserved===true&&record.callCompleted===true
    &&!!record.invocationId&&!!record.approvedDigest&&record.bindingDigest===record.approvedDigest
    &&((grant.state===undefined||grant.state==='active')&&!grant.consumedBy
      ||grant.state==='used'&&grant.consumedBy?.invocationId===record.invocationId&&grant.consumedBy.approvalDigest===record.approvedDigest);
}

/** Pure. installed!=permitted!=invoked!=verified; no state promotes another. 'local' evidence counts as unknown. */
export function aggregate(sections:readonly ToolDiscoverySection[],grants:readonly ToolGrant[],records:readonly ToolInvocationRecord[]):ToolAggregate {
  const keys=new Map<string,ToolKey>(),current=new Map<string,string>(),sectionStatus=new Map<string,string>();
  const touch=(key:ToolKey)=>{const id=keyId(key);if(!keys.has(id))keys.set(id,{runtimeId:key.runtimeId,kind:key.kind,itemId:key.itemId});return id;};
  for(const section of sections){sectionStatus.set(JSON.stringify([section.runtimeId,section.kind]),section.status);for(const meta of section.items){const id=touch({runtimeId:section.runtimeId,kind:meta.kind,itemId:meta.id});current.set(id,itemDigest(meta));}}
  for(const grant of grants)touch(grant.key);for(const record of records)touch(record.key);
  const sortedGrants=[...grants].sort((a,b)=>bySort(a.grantId,b.grantId));
  const states:ToolState[]=[...keys.entries()].sort((a,b)=>bySort(a[0],b[0])).map(([id,key])=>{
    const digest=current.get(id);
    const installed=digest!==undefined?'discovered':sectionStatus.get(JSON.stringify([key.runtimeId,key.kind]))==='available'?'absent':'unknown';
    // grant is void unless its digest equals the current metadata digest
    const grant=toolGrantable(key.runtimeId,key.kind)&&digest!==undefined?sortedGrants.find(g=>(g.state===undefined||g.state==='active')&&keyId(g.key)===id&&g.itemDigest===digest)??null:null;
    const invoked={native:0,mock:0,unknown:0};let verified=0;
    for(const record of records){if(keyId(record.key)!==id)continue;
      if(record.evidenceSource==='native'){invoked.native++;if(digest===record.itemDigest&&sortedGrants.some(g=>toolInvocationVerified(record,g)))verified++;}
      else if(record.evidenceSource==='mock')invoked.mock++;else invoked.unknown++;}
    return {key,installed,permitted:grant?{grantId:grant.grantId,itemDigest:grant.itemDigest}:null,invoked,verified};
  });
  const totals={keys:states.length,installed:0,permitted:0,invoked:{native:0,mock:0,unknown:0},verified:0};
  for(const s of states){if(s.installed==='discovered')totals.installed++;if(s.permitted)totals.permitted++;totals.invoked.native+=s.invoked.native;totals.invoked.mock+=s.invoked.mock;totals.invoked.unknown+=s.invoked.unknown;totals.verified+=s.verified;}
  return {states,totals};
}
