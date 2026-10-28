import type {CapabilityDiscoveryInput,CapabilityEntry,OrchestrationCapabilityId,OrchestrationRegistry,ProviderCapabilityAdapter,ProviderCapabilityView,RuntimeId} from '../shared/capability-orchestration.ts';
import type {NativeProbe} from '../shared/capabilities.ts';
import {containsCredential} from './privacy.ts';
import {inspectOutbound} from './guardrails/outbound.ts';

function own(value:unknown,key:string):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  return descriptor&&'value' in descriptor?descriptor.value:undefined;
}
function items(value:unknown,limit:number):unknown[] {
  if(!Array.isArray(value))return [];
  const result:unknown[]=[];
  for(let index=0;index<Math.min(value.length,limit);index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(descriptor&&'value' in descriptor)result.push(descriptor.value);
  }
  return result;
}
function probe(value:unknown):NativeProbe {
  const status=own(value,'status'),version=own(value,'version');
  const installation:NativeProbe['status']=status==='found'||status==='not_found_on_path'||status==='failed'?status:'unknown';
  const validVersion=installation==='found'&&typeof version==='string'&&/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:[-+][A-Za-z0-9.-]{1,32})?$/.test(version)&&!containsCredential(version)&&inspectOutbound(version).length===0?version:null;
  return {status:installation==='found'&&!validVersion?'unknown':installation,version:validVersion};
}
function observedAt(value:unknown):string|null {
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
}
const ids:readonly OrchestrationCapabilityId[]=['execute.code','execute.general','plan','review.text','model.actual','skills','slash_commands','hooks','mcp','resume','interrupt'];
const implementations:Record<RuntimeId,ReadonlySet<OrchestrationCapabilityId>>={
  codex:new Set(['execute.code','plan','review.text','resume','interrupt']),
  'claude-code':new Set(['execute.general','plan','review.text','model.actual','interrupt']),
};
/** Only metadata presence is observed, never configuredEnabled/nativeTrust as permission. */
function hasMetadata(input:CapabilityDiscoveryInput,kind:'skills'|'hooks'|'mcp'):boolean {
  const inventory=own(input,'extensions');if(own(inventory,'source')!=='codex_app_server')return false;
  const sections=own(inventory,'sections');if(!Array.isArray(sections))return false;
  return items(sections,16).some(section=>{
    const status=own(section,'status');
    if(own(section,'kind')!==kind||(status!=='available'&&status!=='partial'))return false;
    const listed=own(section,'items');
    return items(listed,512).some(item=>{
      const id=own(item,'id'),name=own(item,'name');
      return typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)&&typeof name==='string'&&name.length>0&&name.length<=80
        &&/^[\p{L}\p{M}\p{N} _.:()-]+$/u.test(name)&&!containsCredential(name)&&inspectOutbound(name).length===0;
    });
  });
}
function discoverProvider(runtimeId:RuntimeId,input:CapabilityDiscoveryInput):ProviderCapabilityView {
  const codex=runtimeId==='codex',ready=codex&&own(input,'codexReady')===true;
  const report=own(input,'probe');
  const native=probe(observedAt(own(report,'checkedAt'))?own(report,codex?'codex':'claude'):undefined);
  const capabilities:CapabilityEntry[]=ids.map(id=>{
    const implemented=implementations[runtimeId].has(id);
    const extension=id==='skills'||id==='hooks'||id==='mcp';
    const metadata=codex&&ready&&extension&&hasMetadata(input,id);
    const uncertain=extension||id==='slash_commands';
    // This registry routes Quality Loop work. Its Codex review stays blocked while
    // actual execution model evidence is unavailable; existing Review is unchanged.
    const blocked=uncertain||!implemented||id==='model.actual'||(codex&&id==='review.text');
    const evidence:string[]=[];
    if(implemented)evidence.push('orbit.adapter.implemented');
    // A ready connection may be a read-only text session, not a code execution observation.
    if(metadata)evidence.push(`orbit.codex.${id}.metadata_only`);
    if(codex&&id==='model.actual')evidence.push('codex.app_server.no_turn_model_attestation');
    if(codex&&id==='review.text')evidence.push('orbit.quality_loop.actual_model_required');
    if(extension)evidence.push('orbit.extension.activation_not_authorized');
    return {id,implementation:implemented?'implemented':uncertain?'unknown':'unsupported',observation:metadata?'confirmed':'unknown',policy:blocked?'blocked':'allowed',evidence};
  });
  return {runtimeId,version:native.version,installation:native.status,connection:ready?'ready':'unknown',authentication:ready?'confirmed':'unknown',capabilities};
}

export const providerCapabilityAdapters:readonly ProviderCapabilityAdapter[]=Object.freeze([
  Object.freeze({runtimeId:'codex' as const,discover:(input:CapabilityDiscoveryInput)=>discoverProvider('codex',input)}),
  Object.freeze({runtimeId:'claude-code' as const,discover:(input:CapabilityDiscoveryInput)=>discoverProvider('claude-code',input)}),
]);
export function discoverCapabilities(input:CapabilityDiscoveryInput):OrchestrationRegistry {
  return {schemaVersion:1,observedAt:observedAt(own(own(input,'probe'),'checkedAt')),providers:providerCapabilityAdapters.map(adapter=>adapter.discover(input)),actualModel:'unknown',executionAuthorized:false};
}
