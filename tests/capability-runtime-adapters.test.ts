import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRuntimeAdapters} from '../server/capability-runtime-adapters.ts';
import type {Run} from '../shared/types.ts';
import {discoverCapabilities} from '../server/capability-adapters.ts';

function fixture(){
 const calls:unknown[]=[];
 const adapters=new CapabilityRuntimeAdapters({submitTask:async(...args)=>{calls.push(args);return {id:'run'} as Run;},interrupt:async(id)=>{calls.push(id);}});
 return {adapters,calls};
}
test('runtime compatibility requires observed contract version and changes snapshot identity on version change',()=>{
 const {adapters}=fixture();
 assert.equal(adapters.snapshot('codex',null).compatible,false);
 const compatible=adapters.snapshot('codex','0.162.1');assert.equal(compatible.compatible,true);
 assert.deepEqual(adapters.snapshot('codex','0.162.1'),compatible);
 const newer=adapters.snapshot('codex','0.163.0');assert.equal(newer.compatible,false);assert.equal(newer.revision,compatible.revision);assert.notDeepEqual(newer,compatible);
 for(const version of ['2.1.258','2.1.259-beta','3.0.0','garbage',null])assert.equal(adapters.snapshot('claude-code',version).compatible,false);
 for(const version of ['2.1.259','2.1.260','2.2.0'])assert.equal(adapters.snapshot('claude-code',version).compatible,true);
});
test('discovery, invocation and verification are independent support dimensions',()=>{
 const providers=discoverCapabilities({probe:null,codexReady:false}).providers;
 const codex=providers.find(p=>p.runtimeId==='codex')!,claude=providers.find(p=>p.runtimeId==='claude-code')!;
 for(const kind of ['skills','hooks','mcp']){
  const entry=codex.capabilities.find(c=>c.id===kind)!;
  assert.equal(entry.discovery,'implemented');assert.equal(entry.invocation,'unsupported');assert.equal(entry.verification,'unsupported');assert.equal(entry.policy,'blocked');
 }
 assert.equal(claude.capabilities.find(c=>c.id==='hooks')!.discovery,'unknown');
 assert.equal(codex.capabilities.find(c=>c.id==='slash_commands')!.invocation,'unsupported');
 assert.equal(codex.capabilities.find(c=>c.id==='execute.code')!.invocation,'implemented');
 assert.equal(codex.capabilities.find(c=>c.id==='execute.code')!.verification,'implemented');
 assert.equal(codex.capabilities.find(c=>c.id==='model.actual')!.verification,'unsupported');
});
test('dispatch reuses approved task controller path without arbitrary prompt or fallback',async()=>{
 const {adapters,calls}=fixture();
 await assert.rejects(adapters.dispatch('codex','p','t',{requestId:'request'}),/CAPABILITY_RUNTIME_INCOMPATIBLE/);
 adapters.snapshot('codex','0.162.1');adapters.snapshot('claude-code','2.1.259');
 await assert.rejects(adapters.dispatch('codex','p','t',{requestId:'request'}),/WORKSPACE/);
 await assert.rejects(adapters.dispatch('claude-code','p','t',{requestId:'request',workspaceId:'w'}),/WORKSPACE/);
 await assert.rejects(adapters.dispatch('claude-code','p','t',{requestId:'request',prompt:'/bad'} as never),/INVALID_FIELDS/);
 await adapters.dispatch('codex','p','t',{requestId:'request',workspaceId:'w',expectedAcceptanceDigest:'digest'});
 await adapters.dispatch('claude-code','p','t',{requestId:'request2'});
 assert.equal(calls.length,2);assert.deepEqual(calls[1],['p','t',{requestId:'request2'}]);
 await adapters.interrupt('claude-code','run');assert.equal(calls[2],'run');
});
test('trusted replacement, disable and unregister invalidate contracts but never prevent stopping',async()=>{
 const {adapters,calls}=fixture();
 const before=adapters.snapshot('codex','0.162.1');
 const definition={runtimeId:'codex' as const,adapterId:'reviewed-codex',compatible:(version:string)=>version==='0.162.1'};
 assert.throws(()=>adapters.register(definition,{trusted:false}),/ADAPTER_TRUST_REQUIRED/);
 adapters.register(definition,{trusted:true});
 const after=adapters.snapshot('codex','0.162.1');assert.ok(after.revision>before.revision);assert.equal(after.adapterId,'reviewed-codex');
 adapters.disable('codex');assert.equal(adapters.snapshot('codex','0.162.1').compatible,false);
 await assert.rejects(adapters.dispatch('codex','p','t',{requestId:'request',workspaceId:'w'}),/CAPABILITY_RUNTIME_INCOMPATIBLE/);
 await adapters.interrupt('codex','existing');assert.equal(calls[0],'existing');
 adapters.unregister('codex');assert.equal(adapters.snapshot('codex','0.162.1').issue,'ADAPTER_NOT_REGISTERED');
 adapters.register(definition,{trusted:true});assert.ok(adapters.snapshot('codex','0.162.1').revision>after.revision);
 assert.throws(()=>adapters.register({...definition,runtimeId:'external'} as never,{trusted:true}),/INVALID_ADAPTER/);
});
test('provider failures are surfaced with no paid or alternate-provider fallback',async()=>{
 let count=0;const adapters=new CapabilityRuntimeAdapters({submitTask:async()=>{count++;throw Error('native failed');},interrupt:async()=>{throw Error('stop uncertain');}});
 adapters.snapshot('claude-code','2.1.259');
 await assert.rejects(adapters.dispatch('claude-code','p','t',{requestId:'request'}),/native failed/);assert.equal(count,1);
 await assert.rejects(adapters.interrupt('claude-code','r'),/stop uncertain/);
});
test('trusted registration replaces dispatch and feature changes invalidate the snapshot',async()=>{
 const {adapters,calls}=fixture();let customCalls=0;
 const original=adapters.snapshot('claude-code','2.1.259');
 adapters.register({runtimeId:'claude-code',adapterId:'reviewed.claude.v2',compatible:()=>true,capabilities:['execute.general'],dispatch:async(projectId,taskId,input)=>{
  customCalls++;assert.equal(projectId,'p');assert.equal(taskId,'t');assert.deepEqual(input,{requestId:'request'});return {id:'custom-run'} as Run;
 }},{trusted:true});
 const changed=adapters.snapshot('claude-code','2.1.259');assert.notDeepEqual(changed,original);
 assert.deepEqual(changed.capabilities,['execute.general']);changed.capabilities.length=0;
 const run=await adapters.dispatch('claude-code','p','t',{requestId:'request'});assert.equal(run.id,'custom-run');assert.equal(customCalls,1);assert.equal(calls.length,0);
 adapters.snapshot('claude-code',null);
 await assert.rejects(adapters.dispatch('claude-code','p','t',{requestId:'request'}),/CAPABILITY_RUNTIME_INCOMPATIBLE/);
 adapters.snapshot('claude-code','2.1.259');adapters.disable('claude-code');
 await assert.rejects(adapters.dispatch('claude-code','p','t',{requestId:'request'}),/CAPABILITY_RUNTIME_INCOMPATIBLE/);assert.equal(customCalls,1);
 adapters.register({runtimeId:'claude-code',adapterId:'reviewed.claude.v2',compatible:()=>true,capabilities:[],dispatch:async()=>{customCalls++;throw Error('must not call');}},{trusted:true});
 const removed=adapters.snapshot('claude-code','2.1.259');assert.notDeepEqual(removed,changed);
 await assert.rejects(adapters.dispatch('claude-code','p','t',{requestId:'request'}),/CAPABILITY_NOT_IMPLEMENTED/);assert.equal(customCalls,1);
});
test('registration rejects sensitive ids, unknown capabilities and invalid implementations',()=>{
 const {adapters}=fixture(),definition={runtimeId:'codex' as const,adapterId:'reviewed.codex',compatible:()=>true};
 assert.throws(()=>adapters.register({...definition,adapterId:'sk-proj-'+'a'.repeat(50)},{trusted:true}),/INVALID_ADAPTER/);
 assert.throws(()=>adapters.register({...definition,capabilities:['arbitrary.execute']} as never,{trusted:true}),/INVALID_ADAPTER/);
 assert.throws(()=>adapters.register({...definition,dispatch:'shell command'} as never,{trusted:true}),/INVALID_ADAPTER/);
});
