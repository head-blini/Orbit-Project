import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverCapabilities,providerCapabilityAdapters} from '../server/capability-adapters.ts';
import type {CapabilityDiscoveryInput,OrchestrationCapabilityId,RuntimeId} from '../shared/capability-orchestration.ts';
import type {ExtensionInventory} from '../shared/extensions.ts';
import {Store} from '../server/store.ts';
import {ToolPermissionStore} from '../server/tool-permissions.ts';
import {itemDigest} from '../server/tool-capability-ledger.ts';
import type {ToolDiscoverySection,ToolItemMeta,ToolKind} from '../shared/tool-capabilities.ts';
const input:CapabilityDiscoveryInput={probe:{checkedAt:'2026-10-28T00:00:00.000Z',codex:{status:'found',version:'0.162.1'},claude:{status:'found',version:'2.1.0'}},codexReady:false};
const entry=(runtime:RuntimeId,id:OrchestrationCapabilityId,value:CapabilityDiscoveryInput=input)=>discoverCapabilities(value).providers.find(p=>p.runtimeId===runtime)!.capabilities.find(c=>c.id===id)!;
const inventory:ExtensionInventory={workspaceId:null,source:'codex_app_server',status:'available',checkedAt:'2026-10-28T00:00:00.000Z',sections:['skills','hooks','mcp'].map(kind=>({kind:kind as 'skills'|'hooks'|'mcp',status:'available',issue:null,items:[{id:'a'.repeat(64),name:'Fixture',scope:'thread',configuredEnabled:true,effective:'unknown',version:null,handlerType:'command',nativeTrust:'trusted',pluginOwned:false}]}))};
test('explicit discovery adapters describe existing code and general-purpose execution separately',()=>{
  assert.deepEqual(providerCapabilityAdapters.map(a=>a.runtimeId),['codex','claude-code']);
  assert.equal(entry('codex','execute.code').implementation,'implemented');assert.equal(entry('claude-code','execute.general').implementation,'implemented');
  assert.equal(entry('claude-code','execute.code').implementation,'unsupported');assert.equal(entry('claude-code','resume').implementation,'unsupported');
  for(const runtime of ['codex','claude-code'] as const){assert.equal(entry(runtime,'plan').implementation,'implemented');assert.equal(entry(runtime,'interrupt').implementation,'implemented');}
});
test('installation and version never imply authentication, actual model or observed execution',()=>{
  const registry=discoverCapabilities(input);assert.equal(registry.observedAt,input.probe!.checkedAt);assert.equal(registry.actualModel,'unknown');assert.equal(registry.executionAuthorized,false);
  for(const provider of registry.providers){assert.equal(provider.installation,'found');assert.equal(provider.authentication,'unknown');assert.equal(provider.connection,'unknown');assert.equal(provider.capabilities.every(c=>c.observation==='unknown'),true);}
  assert.equal(entry('codex','model.actual').implementation,'unsupported');assert.equal(entry('claude-code','model.actual').implementation,'implemented');
  assert.equal(entry('claude-code','model.actual').observation,'unknown');assert.equal(entry('codex','review.text').policy,'blocked');
});
test('ready read-only Codex session confirms connection but not code execution capabilities',()=>{
  const session={provider:'ready',readOnly:true,workspaceId:null};
  const ready={...input,codexReady:session.provider==='ready'},provider=discoverCapabilities(ready).providers[0];
  assert.equal(session.readOnly,true);assert.equal(session.workspaceId,null);assert.equal(provider.authentication,'confirmed');assert.equal(provider.connection,'ready');
  assert.equal(entry('codex','execute.code',ready).observation,'unknown');assert.equal(entry('codex','plan',ready).observation,'unknown');assert.equal(entry('codex','resume',ready).observation,'unknown');
  assert.equal(entry('codex','model.actual',ready).observation,'unknown');assert.equal(entry('codex','model.actual',ready).policy,'blocked');assert.equal(discoverCapabilities(ready).executionAuthorized,false);
});
test('configured enabled trusted extensions are metadata, never execution permission',()=>{
  const ready={...input,codexReady:true,extensions:inventory};
  for(const kind of ['skills','hooks','mcp'] as const){const value=entry('codex',kind,ready);assert.equal(value.observation,'confirmed');assert.equal(value.policy,'blocked');assert.equal(value.implementation,'unknown');assert.ok(value.evidence.includes(`orbit.codex.${kind}.metadata_only`));}
  assert.equal(entry('codex','slash_commands',ready).implementation,'unknown');assert.equal(entry('codex','slash_commands',ready).observation,'unknown');assert.equal(entry('codex','slash_commands',ready).policy,'blocked');
  assert.equal(entry('claude-code','skills',ready).observation,'unknown');assert.equal(entry('codex','skills',{...ready,codexReady:false}).observation,'unknown');
});
test('malformed or missing extension metadata cannot grant observed extension support',()=>{
  for(const value of [{...inventory,source:'not_queried'},{...inventory,sections:[]},{...inventory,sections:[{kind:'skills',status:'available',items:[{id:'untrusted',name:'secret@example.com'}]}]}]){
    assert.equal(entry('codex','skills',{...input,codexReady:true,extensions:value as ExtensionInventory}).observation,'unknown');
  }
});
test('untrusted probe strings and fields are not exposed as versions or capability evidence',()=>{
  for(const version of ['token secret','https://private.example/path','0.162.1\nsecret','x'.repeat(100),{},null]){
    const value={...input,probe:{checkedAt:'secret@example.com',codex:{status:'found',version},claude:{status:'forged',version}}} as unknown as CapabilityDiscoveryInput;
    const registry=discoverCapabilities(value);assert.equal(registry.observedAt,null);assert.equal(registry.providers[0].version,null);assert.equal(registry.providers[1].installation,'unknown');assert.equal(registry.providers[1].version,null);
    assert.equal(JSON.stringify(registry).includes('private.example'),false);
  }
  const registry=discoverCapabilities({probe:null,codexReady:false});assert.equal(registry.providers.every(p=>p.installation==='unknown'&&p.version===null),true);
});
test('accessor metadata is not invoked and returned views cannot mutate registered adapters',()=>{
  let invoked=false;const value={codexReady:false,get probe(){invoked=true;throw Error('private');}} as unknown as CapabilityDiscoveryInput;
  assert.doesNotThrow(()=>discoverCapabilities(value));assert.equal(invoked,false);
  const first=discoverCapabilities(input);first.providers[0].capabilities[0].policy='blocked';first.providers[0].capabilities[0].evidence.push('mutation');
  assert.equal(entry('codex','execute.code').policy,'allowed');assert.equal(entry('codex','execute.code').evidence.includes('mutation'),false);
});
test('found requires a valid probe version and observation time before routing can trust installation',()=>{
  for(const version of [null,'',{},'bad-version','0.162.1\nsecret']){
    const value={...input,probe:{...input.probe,codex:{status:'found',version}}} as unknown as CapabilityDiscoveryInput;
    const provider=discoverCapabilities(value).providers[0];assert.equal(provider.installation,'unknown');assert.equal(provider.version,null);
  }
  for(const checkedAt of [null,undefined,'invalid','2026-99-99T00:00:00Z']){
    const value={...input,probe:{...input.probe,checkedAt}} as unknown as CapabilityDiscoveryInput;
    const registry=discoverCapabilities(value);assert.equal(registry.observedAt,null);
    for(const provider of registry.providers){assert.equal(provider.installation,'unknown');assert.equal(provider.version,null);}
  }
  assert.equal(discoverCapabilities(input).providers[0].installation,'found');
});


test('only a current task grant permits Codex MCP without verifying or enabling invocation',()=>{
  const store=new Store(':memory:');try{
    const permissions=new ToolPermissionStore(store);
    const meta:ToolItemMeta={kind:'mcp',id:'a'.repeat(64),scope:'thread',handlerType:null,nativeTrust:'unknown',pluginOwned:false,runtimeVersion:'0.162.1',adapterRevision:'fixture'};
    const key={runtimeId:'codex' as const,kind:'mcp' as const,itemId:meta.id};
    const sections:ToolDiscoverySection[]=[{runtimeId:'codex',kind:'mcp',status:'available',items:[meta]}];
    const context={projectId:'project',taskId:'task',sections,permissions};
    const view=()=>discoverCapabilities(input,context);
    const mcp=(r:ReturnType<typeof view>)=>r.providers[0].capabilities.find(c=>c.id==='mcp')!;
    assert.equal(discoverCapabilities(input).tools,undefined);
    assert.equal(mcp(view()).policy,'blocked');assert.equal(view().tools!.totals.installed,1);
    const grant=permissions.grant({requestId:'request',projectId:'project',taskId:'task',key,itemDigest:itemDigest(meta),confirmed:true});
    const permitted=view();
    assert.equal(mcp(permitted).policy,'allowed');assert.equal(mcp(permitted).invocation,'unsupported');
    assert.equal(mcp(permitted).observation,'unknown');assert.equal(mcp(permitted).verification,'unsupported');
    assert.ok(mcp(permitted).evidence.includes('orbit.tool.task_grant.permitted'));
    assert.deepEqual(permitted.tools!.states[0],{key,installed:'discovered',permitted:{grantId:grant.grantId,itemDigest:itemDigest(meta)},invoked:{native:0,mock:0,unknown:0},verified:0});assert.equal(permitted.executionAuthorized,false);
    assert.deepEqual(permitted.tools!.totals,{keys:1,installed:1,permitted:1,invoked:{native:0,mock:0,unknown:0},verified:0});
    assert.equal(discoverCapabilities(input,{...context,taskId:'other'}).tools!.totals.permitted,0);
    assert.equal(discoverCapabilities(input,{...context,projectId:'other'}).tools!.totals.permitted,0);
    for(const field of ['runtimeVersion','adapterRevision','nativeTrust'] as const){
      const changed={...context,sections:[{...sections[0],items:[{...meta,[field]:'changed'}]}]};
      assert.equal(mcp(discoverCapabilities(input,changed)).policy,'blocked');
    }
    permissions.revoke(grant.grantId);assert.equal(mcp(view()).policy,'blocked');
    const next=permissions.grant({requestId:'next',projectId:'project',taskId:'task',key,itemDigest:itemDigest(meta),confirmed:true});
    permissions.consume(next.grantId,{projectId:'project',taskId:'task',key,itemDigest:itemDigest(meta)});
    assert.equal(mcp(view()).policy,'blocked');
  }finally{store.close();}
});

test('unsupported tool kinds and Claude MCP remain discovery-only even with a permissive grant reader',()=>{
  const kinds:ToolKind[]=['mcp','skill','hook','subagent','plugin','slash_command'];
  const sections:ToolDiscoverySection[]=(['codex','claude-code'] as const).flatMap(runtimeId=>kinds.map(kind=>({runtimeId,kind,status:'available' as const,items:[{kind,id:'a'.repeat(64),scope:null,handlerType:null,nativeTrust:null,pluginOwned:null,runtimeVersion:null,adapterRevision:null}]})));
  const r=discoverCapabilities(input,{projectId:'project',taskId:'task',sections,permissions:{validFor:(key,digest)=>({key,grantId:'fixture',itemDigest:digest})}});
  assert.equal(r.tools!.totals.installed,12);assert.equal(r.tools!.totals.permitted,1);assert.equal(r.tools!.totals.verified,0);
  for(const provider of r.providers)for(const id of ['skills','hooks','slash_commands','subagents','mcp'] as const){
    assert.equal(provider.capabilities.find(c=>c.id===id)!.policy,provider.runtimeId==='codex'&&id==='mcp'?'allowed':'blocked');
  }
});
