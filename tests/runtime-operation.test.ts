import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {CapabilityRuntimeAdapters} from '../server/capability-runtime-adapters.ts';

function fixture(){
 const store=new Store(':memory:');let dispatches=0;const stops:string[]=[];
 const adapters=new CapabilityRuntimeAdapters({store,submitTask:async()=>{dispatches++;throw Error('unexpected dispatch');},interrupt:async(id)=>{stops.push(id);}});
 const run=store.createRun('request','digest','prompt',undefined,{runtime:'claude-code',projectId:'project',taskId:'task'});
 return {store,adapters,run,stops,dispatches:()=>dispatches};
}
test('observe is read-only, preserves unknown and exposes only completed response',()=>{
 const f=fixture();try{
  f.store.updateRun(f.run.id,{execution:'running',response:'partial'},'run.started');const seq=f.store.lastSeq();
  const running=f.adapters.observe('claude-code','project',f.run.id);
  assert.equal(running.response,null);assert.equal(running.terminal,false);assert.equal(running.stopConfirmed,false);
  assert.equal(running.providerEvidence.source,'unknown');assert.equal(running.providerEvidence.livePipelineVerified,false);
  assert.equal(f.store.lastSeq(),seq);assert.equal(f.dispatches(),0);
  f.store.updateRun(f.run.id,{execution:'completed',response:'safe saved result'},'run.completed');
  assert.equal(f.adapters.observe('claude-code','project',f.run.id).response,'safe saved result');
 }finally{f.store.close();}
});
test('ownership rejects mismatched runtime or project before observe or stop',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.adapters.observe('codex','project',f.run.id),/RUNTIME_MISMATCH/);
  assert.throws(()=>f.adapters.observe('claude-code','other',f.run.id),/PROJECT_MISMATCH/);
  assert.throws(()=>f.adapters.observe('claude-code',undefined as never,f.run.id),/PROJECT_MISMATCH/);
  await assert.rejects(f.adapters.interrupt('codex',f.run.id),/RUNTIME_MISMATCH/);
  await assert.rejects(f.adapters.interrupt('claude-code',f.run.id,'other'),/PROJECT_MISMATCH/);
  assert.deepEqual(f.stops,[]);
 }finally{f.store.close();}
});
test('disabled or removed adapter can observe and stop existing run; late completion remains authoritative',async()=>{
 const f=fixture();try{
  f.adapters.snapshot('claude-code','3.0.0');
  assert.equal(f.adapters.observe('claude-code','project',f.run.id).execution,'starting');
  f.adapters.disable('claude-code');f.adapters.unregister('claude-code');
  f.store.updateRun(f.run.id,{execution:'interrupting'},'interrupt.requested');
  await f.adapters.interrupt('claude-code',f.run.id,'project');assert.deepEqual(f.stops,[f.run.id]);
  assert.equal(f.adapters.observe('claude-code','project',f.run.id).stopConfirmed,false);
  f.store.updateRun(f.run.id,{execution:'completed',response:'late result'},'run.completed');
  const result=f.adapters.observe('claude-code','project',f.run.id);assert.equal(result.execution,'completed');assert.equal(result.stopConfirmed,true);
  const lostRun=f.store.createRun('lost-request','digest','prompt',undefined,{runtime:'claude-code',projectId:'project'});
  f.store.updateRun(lostRun.id,{execution:'lost'},'run.lost');
  const lost=f.adapters.observe('claude-code','project',lostRun.id);assert.equal(lost.terminal,true);assert.equal(lost.stopConfirmed,false);assert.equal(lost.response,null);
 }finally{f.store.close();}
});
test('legacy Codex project ownership resolves from workspace and missing run fails closed',()=>{
 const f=fixture();try{
  f.store.db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace',JSON.stringify({id:'workspace',projectId:'project'}));
  const run=f.store.createRun('legacy','digest','prompt','workspace');
  assert.equal(f.adapters.observe('codex','project',run.id).runtimeId,'codex');
  assert.throws(()=>f.adapters.observe('codex','project','missing'),/RUN_NOT_FOUND/);
 }finally{f.store.close();}
});
