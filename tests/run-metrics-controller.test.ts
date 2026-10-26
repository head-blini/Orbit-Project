import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import type {RunMetrics} from '../shared/analytics.ts';

class Fake extends EventEmitter {
  turns=0;calls:string[]=[];startGate:Promise<void>|null=null;started:((turnId:string)=>void)|null=null;
  async initialize(){}async close(){this.emit('closed');}
  async request(method:string,params:any):Promise<any>{
    this.calls.push(method);
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='thread/start'||method==='thread/resume')return {model:'fixture-model',modelProvider:'openai',thread:{id:'fixture-metrics-thread',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user'};
    if(method==='mcpServerStatus/list')return {data:[]};
    if(method==='turn/start'){const id='turn-'+(++this.turns);this.started?.(id);if(this.startGate)await this.startGate;return {turn:{id}};}
    throw new Error('UNEXPECTED_METHOD');
  }
  usage(turnId:string,n:number){const c={inputTokens:n,outputTokens:0,totalTokens:n,cachedInputTokens:0,reasoningOutputTokens:0};this.emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:'fixture-metrics-thread',turnId,tokenUsage:{total:c,last:c}}});}
  finish(turnId:string){this.emit('notification',{method:'turn/completed',params:{threadId:'fixture-metrics-thread',turn:{id:turnId,status:'completed'}}});}
}
test('passive metrics bind to native runs, survive receipt replay and late usage without altering terminal execution',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-metrics-')),store=new Store(':memory:'),rpc=new Fake(),c=new Controller(store,createWorkspace(root),()=>rpc);
  try{
    await c.connect();const a=await c.submit({requestId:'metrics-first',prompt:'first'});rpc.usage(a.turnId!,100);rpc.finish(a.turnId!);
    assert.equal(store.getRunMetrics(a.id)?.tokenStatus,'unknown');assert.equal(store.getRunMetrics(a.id)?.modelAtStart,'fixture-model');assert.ok(store.getRunMetrics(a.id)?.durationMs!==null);
    const input={requestId:'metrics-second',prompt:'second'},b=await c.submit(input);rpc.usage(b.turnId!,150);rpc.finish(b.turnId!);
    const before=store.getRun(b.id),duration=store.getRunMetrics(b.id)!.durationMs;assert.equal(store.getRunMetrics(b.id)!.tokens?.totalTokens,50);
    rpc.usage(b.turnId!,160);assert.equal(store.getRunMetrics(b.id)!.tokens?.totalTokens,60);assert.equal(store.getRunMetrics(b.id)!.durationMs,duration);assert.deepEqual(store.getRun(b.id),before);
    await c.submit(input);assert.equal(rpc.turns,2);assert.deepEqual(store.getRun(b.id),before);assert.equal(rpc.calls.some(method=>method.startsWith('account/usage')||method.startsWith('account/rateLimits')),false);
    await c.close();const saved=store.getRunMetrics(b.id);rpc.usage(b.turnId!,999);assert.deepEqual(store.getRunMetrics(b.id),saved);
  }finally{await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('lost running metrics are invalidated on restart and no elapsed time is fabricated from updatedAt',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-metrics-restart-')),path=join(root,'fixture.sqlite');let store=new Store(path);
  try{
    const r=store.createRun('restart-metrics','hash','fixture');
    const metrics:RunMetrics={runId:r.id,threadId:'thread',turnId:'turn',modelAtStart:'model',modelProvider:'openai',modelChanged:false,tokens:{inputTokens:5,outputTokens:0,totalTokens:5,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},tokenStatus:'observed',tokenIssue:null,observedAt:new Date().toISOString(),finishedAt:null,durationMs:null,retryNotices:0};
    store.saveRunMetrics(metrics);store.close();store=new Store(path);
    assert.equal(store.getRun(r.id)!.execution,'lost');const saved=store.getRunMetrics(r.id)!;assert.equal(saved.tokenStatus,'incomplete');assert.equal(saved.tokenIssue,'CONNECTION_LOST');assert.equal(saved.tokens,null);assert.equal(saved.durationMs,null);assert.equal(saved.finishedAt,null);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('failed metrics writes cannot prevent completion and expose an incomplete volatile observation until saved',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-metrics-failure-')),store=new Store(':memory:'),rpc=new Fake(),c=new Controller(store,createWorkspace(root),()=>rpc);
  try{
    await c.connect();
    store.db.exec("CREATE TRIGGER fail_metrics BEFORE UPDATE ON run_metrics BEGIN SELECT RAISE(FAIL,'fixture metrics failure'); END;");
    const a=await c.submit({requestId:'metrics-failure',prompt:'fixture'});
    rpc.usage(a.turnId!,100);rpc.finish(a.turnId!);
    assert.equal(store.getRun(a.id)!.execution,'completed');assert.equal(store.getRunMetrics(a.id)?.tokenStatus,'incomplete');assert.equal(store.getRunMetrics(a.id)?.tokenIssue,'STORAGE_UNAVAILABLE');
    assert.ok(store.getRunMetrics(a.id)?.durationMs!==null);
    store.db.exec('DROP TRIGGER fail_metrics');rpc.usage(a.turnId!,110);
    assert.equal(store.runMetricsOverlay(a.id),null);assert.notEqual(store.getRunMetrics(a.id)?.tokenIssue,'STORAGE_UNAVAILABLE');
    const b=await c.submit({requestId:'metrics-after-failure',prompt:'next'});rpc.usage(b.turnId!,150);rpc.finish(b.turnId!);assert.equal(store.getRunMetrics(b.id)?.tokens?.totalTokens,40);assert.ok(store.getRunMetrics(b.id)?.durationMs!==null);
  }finally{await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('terminal boundary before delayed acknowledgement is measured once and remains fixed after ack',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-metrics-preack-')),store=new Store(':memory:'),rpc=new Fake(),c=new Controller(store,createWorkspace(root),()=>rpc);
  let release!:()=>void,reached!:()=>void;rpc.startGate=new Promise(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{reached=resolve;});
  rpc.started=turnId=>{rpc.finish(turnId);reached();};
  try{
    await c.connect();const pending=c.submit({requestId:'metrics-preack',prompt:'fixture'});await started;
    const r=store.runs()[0],before=store.getRunMetrics(r.id)!;assert.equal(before.turnId,null);assert.ok(before.finishedAt);assert.ok(before.durationMs!==null);
    release();await pending;const after=store.getRunMetrics(r.id)!;assert.equal(after.finishedAt,before.finishedAt);assert.equal(after.durationMs,before.durationMs);assert.equal(after.turnId,'turn-1');
  }finally{release();await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('metrics-only recovery failure keeps startup available with an incomplete volatile projection',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-metrics-recovery-failure-')),path=join(root,'fixture.sqlite'),store=new Store(path);let reopened:Store|undefined;
  const r=store.createRun('metrics-recovery-failure','hash','fixture');store.saveRunMetrics({runId:r.id,threadId:'thread',turnId:'turn',modelAtStart:null,modelProvider:null,modelChanged:false,tokens:null,tokenStatus:'unknown',tokenIssue:'NO_BASELINE',observedAt:null,finishedAt:null,durationMs:null,retryNotices:0});store.updateRun(r.id,{execution:'lost'},'run.lost');
  store.db.exec("CREATE TRIGGER fail_recovery_metrics BEFORE UPDATE ON run_metrics BEGIN SELECT RAISE(FAIL,'fixture'); END;");store.close();
  try{assert.doesNotThrow(()=>{reopened=new Store(path);});assert.equal(reopened!.getRun(r.id)?.execution,'lost');assert.equal(reopened!.getRunMetrics(r.id)?.tokenIssue,'STORAGE_UNAVAILABLE');}
  finally{reopened?.close();rmSync(root,{recursive:true,force:true});}
});
