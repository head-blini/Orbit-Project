import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {discoverCapabilities} from '../server/capability-adapters.ts';
import {enrichCapabilityValidation} from '../server/capability-validation.ts';
import type {OrchestrationCapabilityId,OrchestrationRegistry,RuntimeId} from '../shared/capability-orchestration.ts';
const registry=()=>discoverCapabilities({probe:null,codexReady:false});
const entry=(r:OrchestrationRegistry,runtime:RuntimeId,id:OrchestrationCapabilityId)=>r.providers.find(p=>p.runtimeId===runtime)!.capabilities.find(c=>c.id===id)!;
function run(store:Store,source:'native'|'mock'|'unknown',runtime:RuntimeId='codex',observed=true){
 const run=store.createRun(randomUUID(),'fixture','fixture',undefined,{runtime,taskId:'task'});
 if(source!=='unknown')store.append('run.runtime_source',run.id,{source,interface:runtime==='codex'?'codex.app_server':'claude.print'});
 if(runtime==='claude-code'&&observed)store.append('run.runtime_outcome',run.id,{source,dispatch:'started',exit:'observed'});
 return store.updateRun(run.id,{execution:'completed',...(runtime==='codex'&&observed?{turnId:'turn'}:{})},'run.completed');
}
test('status and result reuse stored lifecycle; subagent documents never authorize invocation',()=>{
 const r=registry();for(const runtime of ['codex','claude-code'] as const){
  for(const id of ['status','result'] as const){const c=entry(r,runtime,id);assert.equal(c.discovery,'implemented');assert.equal(c.invocation,'implemented');assert.equal(c.verification,'implemented');assert.equal(c.policy,'allowed');assert.equal(c.observation,'unknown');}
  const c=entry(r,runtime,'subagents');assert.equal(c.discovery,'unknown');assert.equal(c.invocation,'unsupported');assert.equal(c.verification,'unsupported');assert.equal(c.policy,'blocked');assert.equal(c.observation,'unknown');
 }
});
test('validation separates native mock and unknown completed task history without mutating discovery or writing',()=>{
 const store=new Store(':memory:');try{
  run(store,'native');run(store,'mock');run(store,'unknown');const last=run(store,'native','codex',false);
  store.createRun(randomUUID(),'fixture','incomplete',undefined,{runtime:'codex',taskId:'task'});
  const untasked=store.createRun(randomUUID(),'fixture','untasked');store.updateRun(untasked.id,{execution:'completed',turnId:'turn'},'run.completed');
  const r=registry(),seq=store.lastSeq(),enriched=enrichCapabilityValidation(r,store);
  assert.deepEqual(entry(enriched,'codex','execute.code').validation,{nativeRuns:1,mockRuns:1,unknownRuns:2,lastRunId:last.id});
  assert.equal(entry(r,'codex','execute.code').validation,undefined);assert.equal(store.lastSeq(),seq);
  assert.equal(entry(enriched,'codex','execute.code').observation,'unknown');assert.equal(enriched.actualModel,'unknown');assert.equal(enriched.executionAuthorized,false);
  assert.equal(entry(enriched,'codex','model.actual').validation!.nativeRuns,0);
 }finally{store.close();}
});
test('actual model validation needs observed assistant attribution and preserves mock provenance',()=>{
 const store=new Store(':memory:');try{
  const actual=run(store,'native','claude-code');store.append('run.identity',actual.id,{providerId:'anthropic',modelId:'observed-a',sessionId:'session-a',executionId:null,modelEvidence:'assistant_message'});
  const mock=run(store,'mock','claude-code');store.append('run.identity',mock.id,{providerId:'anthropic',modelId:'observed-b',sessionId:'session-b',executionId:null,modelEvidence:'assistant_message'});
  const configured=run(store,'native','claude-code');store.append('run.identity',configured.id,{providerId:'anthropic',modelId:'configured',sessionId:'session-c',executionId:null,modelEvidence:'unknown'});
  const r=enrichCapabilityValidation(registry(),store),model=entry(r,'claude-code','model.actual');
  assert.deepEqual(model.validation,{nativeRuns:1,mockRuns:1,unknownRuns:0,lastRunId:mock.id});assert.equal(model.policy,'blocked');assert.equal(model.observation,'unknown');
  assert.equal(entry(r,'claude-code','execute.general').validation!.nativeRuns,2);assert.equal(entry(r,'claude-code','status').validation!.nativeRuns,0);
 }finally{store.close();}
});
