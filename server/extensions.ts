import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {inspectOutbound} from './guardrails/outbound.ts';
import type {ExtensionInventory,ExtensionItem,ExtensionKind,ExtensionSection} from '../shared/extensions.ts';

export interface ExtensionsContext {workspaceId:string|null;workspacePath:string;threadId:string;knownMcpNames:readonly string[]}
type RecordFields=Record<string,PropertyDescriptor>;
class InvalidMetadata extends Error {readonly issue:string;constructor(issue='EXTENSIONS_INVALID_RESPONSE'){super(issue);this.issue=issue;}}
function invalid(issue?:string):never{throw new InvalidMetadata(issue);}
function record(value:unknown):RecordFields {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  return Object.getOwnPropertyDescriptors(value);
}
function field(data:RecordFields,name:string,optional=false):unknown {
  const value=data[name];if(!Object.hasOwn(data,name)){if(optional)return undefined;return invalid();}
  if(!('value' in value))invalid();return value.value;
}
function listLength(value:unknown,maximum=100):number {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)invalid();
  const length=Object.getOwnPropertyDescriptor(value,'length')?.value;if(!Number.isSafeInteger(length)||length<0)invalid();if(length>maximum)invalid('EXTENSIONS_RESPONSE_TOO_LARGE');return length;
}
function list(value:unknown,maximum=100):unknown[]{
  const length=listLength(value,maximum),result:unknown[]=[];if(Reflect.ownKeys(value as object).length!==length+1)invalid();
  for(let index=0;index<length;index++){const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!descriptor||!('value' in descriptor))invalid();result.push(descriptor.value);}return result;
}
function identity(value:unknown):string {if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value))invalid();return value;}
function id(kind:ExtensionKind,value:string):string{return createHash('sha256').update(JSON.stringify([kind,value])).digest('hex');}
function label(value:string):{name:string;masked:boolean}{
  const safe=!!value.trim()&&value.length<=80&&/^[\p{L}\p{M}\p{N} _.:()-]+$/u.test(value)&&!containsCredential(value)&&inspectOutbound(value).length===0;
  return {name:safe?value:'민감하거나 표시할 수 없는 이름',masked:!safe};
}
function enabled(data:RecordFields){const value=field(data,'enabled');if(typeof value!=='boolean')invalid();return value;}
function pluginOwned(data:RecordFields):boolean|null {
  const value=field(data,'pluginId',true);if(value===undefined)return null;if(value===null)return false;if(typeof value!=='string'||!value||value.length>4096)invalid();return true;
}
function empty(kind:ExtensionKind):ExtensionSection{return {kind,status:kind==='plugins'?'not_connected':'unknown',issue:null,items:[]};}
/** No RPC, filesystem, CLI discovery, installation or activation at import/GET. */
export function unknownExtensions(workspaceId:string|null):ExtensionInventory {
  return {workspaceId,source:'not_queried',status:'unknown',checkedAt:null,sections:(['skills','hooks','mcp','plugins'] as const).map(empty)};
}
function contextSnapshot(input:ExtensionsContext):ExtensionsContext {
  const fields=record(input);if(Reflect.ownKeys(input).length!==4)invalid();const workspaceId=field(fields,'workspaceId'),workspacePath=field(fields,'workspacePath'),threadId=field(fields,'threadId');
  if(workspaceId!==null&&(typeof workspaceId!=='string'||!workspaceId||workspaceId.length>128)||typeof workspacePath!=='string'||workspacePath.length>2000||!isAbsolute(workspacePath)||/[\x00-\x1f\x7f]/.test(workspacePath)||typeof threadId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(threadId)||containsCredential(threadId))invalid();
  const names=list(field(fields,'knownMcpNames')).map(identity);if(new Set(names).size!==names.length)invalid();
  return {workspaceId:workspaceId as string|null,workspacePath,threadId,knownMcpNames:Object.freeze(names)};
}
function mcpSection(value:unknown,known:readonly string[]):ExtensionSection {
  const root=record(value),rows=list(field(root,'data')),cursor=field(root,'nextCursor',true);
  if(cursor!==null&&cursor!==undefined||rows.length!==known.length)invalid();const remaining=new Set(known),items:ExtensionItem[]=[];let masked=false;
  for(const row of rows){const fields=record(row),name=identity(field(fields,'name')),runtime=field(fields,'runtimeStatus'),tools=field(fields,'tools');
    if(!remaining.delete(name)||runtime!=='disabled'||Reflect.ownKeys(record(tools)).length)invalid();
    const display=label(name);masked=masked||display.masked;
    items.push({id:id('mcp',name),name:display.name,scope:'thread',configuredEnabled:false,effective:'blocked_policy',version:null,handlerType:null,nativeTrust:'unknown',pluginOwned:pluginOwned(fields)});
  }
  if(remaining.size)invalid();return {kind:'mcp',status:masked?'partial':'available',issue:masked?'EXTENSIONS_PARTIAL_METADATA':null,items};
}
const skillScopes=new Set(['user','repo','system','admin']);
const hookSources=new Set(['system','user','project','mdm','sessionFlags','plugin','cloudRequirements','cloudManagedConfig','legacyManagedConfigFile','legacyManagedConfigMdm','unknown']);
const hookEvents=new Set(['preModelRequest','postModelRequest','preToolUse','permissionRequest','postToolUse','preCompact','postCompact','sessionStart','sessionEnd','userPromptSubmit','subagentStart','subagentStop','stop','interrupt']);
const hookTrust=new Set(['managed','untrusted','trusted','modified']),hookHandlers=new Set(['command','mcpTool','prompt','agent']);
function section(value:unknown,kind:'skills'|'hooks',workspacePath:string):ExtensionSection {
  const root=record(value),entries=list(field(root,'data'),1);if(entries.length!==1)invalid();const entry=record(entries[0]);if(field(entry,'cwd')!==workspacePath)invalid();
  // Only count diagnostics. Never read raw error/warning messages, paths or getters.
  let partial=listLength(field(entry,'errors'))>0;if(kind==='hooks')partial=listLength(field(entry,'warnings'))>0||partial;
  const rows=list(field(entry,kind)),items:ExtensionItem[]=[],seen=new Set<string>();
  for(const row of rows){const fields=record(row);let item:ExtensionItem;
    if(kind==='skills'){
      const path=identity(field(fields,'path')),name=field(fields,'name'),scope=field(fields,'scope');if(typeof name!=='string'||name.length>4096||typeof scope!=='string'||!skillScopes.has(scope))invalid();
      const display=label(name);partial=partial||display.masked;
      item={id:id(kind,path),name:display.name,scope,configuredEnabled:enabled(fields),effective:'unknown',version:null,handlerType:null,nativeTrust:'unknown',pluginOwned:pluginOwned(fields)};
    }else{
      const key=identity(field(fields,'key')),event=field(fields,'eventName'),source=field(fields,'source'),trust=field(fields,'trustStatus'),handler=field(fields,'handlerType');
      if(typeof event!=='string'||!hookEvents.has(event)||typeof source!=='string'||!hookSources.has(source)||typeof trust!=='string'||!hookTrust.has(trust)||typeof handler!=='string'||!hookHandlers.has(handler))invalid();
      item={id:id(kind,key),name:event,scope:source,configuredEnabled:enabled(fields),effective:'blocked_policy',version:null,handlerType:handler as ExtensionItem['handlerType'],nativeTrust:trust as ExtensionItem['nativeTrust'],pluginOwned:pluginOwned(fields)};
    }
    if(seen.has(item.id))invalid();seen.add(item.id);items.push(item);
  }
  return {kind,status:partial?'partial':'available',issue:partial?'EXTENSIONS_PARTIAL_METADATA':null,items};
}
/** Explicit caller-approved metadata collection only. The caller must hold the
 * ready-session generation and mutual exclusion lock and discard stale results.
 * MCP failure invalidates session authority; skills/hooks failure does not infer
 * absence or activation. All returned fields are detached allowlist scalars.
 */
export async function collectExtensions(request:(method:string,params:unknown)=>Promise<unknown>,input:ExtensionsContext):Promise<ExtensionInventory>{
  let context:ExtensionsContext,mcp:ExtensionSection;
  try{context=contextSnapshot(input);mcp=mcpSection(await request('mcpServerStatus/list',{threadId:context.threadId,detail:'toolsAndAuthOnly',limit:100}),context.knownMcpNames);}
  catch{throw new AppError('MCP_ISOLATION_REQUIRED',503);}
  const collect=async(kind:'skills'|'hooks'):Promise<ExtensionSection>=>{
    let response:unknown;try{response=await request(kind+'/list',kind==='skills'?{cwds:[context.workspacePath],forceReload:false}:{cwds:[context.workspacePath]});}
    catch{return {kind,status:'unknown',issue:'EXTENSIONS_REQUEST_FAILED',items:[]};}
    try{return section(response,kind,context.workspacePath);}catch(error){return {kind,status:'unknown',issue:error instanceof InvalidMetadata?error.issue:'EXTENSIONS_INVALID_RESPONSE',items:[]};}
  };
  const settled=await Promise.allSettled([collect('skills'),collect('hooks')]);
  const sections:ExtensionSection[]=[...settled.map((entry,index)=>entry.status==='fulfilled'?entry.value:{kind:index===0?'skills':'hooks',status:'unknown',issue:'EXTENSIONS_REQUEST_FAILED',items:[]} as ExtensionSection),mcp,empty('plugins')];
  return {workspaceId:context.workspaceId,source:'codex_app_server',status:sections.slice(0,3).every(section=>section.status==='available')?'available':'partial',checkedAt:new Date().toISOString(),sections};
}
